import dmxlib from "dmxnet";
import * as dmxnet from "dmxnet";
import readline from "readline";
import { createWriteStream, createReadStream } from "fs";
import { createGzip, createGunzip } from "zlib";
import { join } from "path";
import { readdirSync } from "fs";

type RecordingMetadata = {
  filename: string;
  createdAt: Date;
  universes: number[];
};

type Packet = {
  TS: Date;
  U: number;
  S: number;
  N: number;
  data: Buffer;
};

type Frame = {
  delay: number;
  packet: Packet[];
};

export type PlayerConfig = {
  universes: number[];
  outputs: {
    ip: string;
    universe: number[];
  }[];
};

type PromptConfig = {
  commands: {
    name: string;
    description: string;
    action: (...args: any) => void;
  }[];
};

export class DMXRecorder {
  private dmxnet: any;
  private inputUnis: number[];
  private outputs: {
    ip: string;
    universe: number[];
  }[];

  private senders: any[];

  private verbose: boolean = false;

  private frames: Frame[] = [];
  private playbackFPS: number = 30;
  private playing: boolean = false;
  private recording: boolean = false;
  private passthrough: boolean = true;
  private metadata: RecordingMetadata | undefined;

  private playerMeta: RecordingMetadata | undefined;
  private playerContent: Packet[] | undefined;
  private nextClip: Packet[] | undefined;

  private timeout: NodeJS.Timeout | null = null;

  private fileStream: ReturnType<typeof createWriteStream> | undefined;
  private gzip: ReturnType<typeof createGzip> | undefined;

  private rl: readline.Interface | undefined;
  private promptConfig: PromptConfig = {
    commands: [
      {
        name: "help",
        description: "Show this help message.",
        action: () => {
          this.promptConfig.commands.forEach((command) => {
            console.log(`\t${command.name} - ${command.description}`);
          });
        },
      },
      {
        name: "log",
        description: "Enables/Disable logging of raw incoming data.",
        action: () => {
          console.log(
            `${new Date().toISOString()} [dmxrec] info: Logging raw data: ${!this
              .verbose}`
          );

          this.verbose = !this.verbose;
        },
      },
      {
        name: "config",
        description: "Prints the current configuration.",
        action: () => {
          console.log(
            `${new Date().toISOString()} [dmxrec] config: Input universes: ${
              this.inputUnis
            }`
          );

          this.outputs.forEach((output) => {
            if (!output) return;
            console.log(
              `${new Date().toISOString()} [dmxrec] config: Output IP: ${
                output.ip
              } - Universes: ${output.universe.join(", ")}`
            );
          });
        },
      },
      {
        name: "record",
        description: "Start recording DMX data.",
        action: () => this.record(),
      },
      {
        name: "stop",
        description: "Stop recording DMX data.",
        action: () => this.close(),
      },
      {
        name: "play",
        description: "Load and parse a recorded file.",
        action: (filename: string[]) => this.play(filename[0]),
      },
      {
        name: "end",
        description: "Ends playback.",
        action: () => (this.playing = false),
      },
      {
        name: "highlight",
        description: "Blink lights on the specified universe.",
        action: (universe: number) => this.highLight(universe),
      },
      {
        name: "passthrough",
        description: "Toggle passthrough mode.",
        action: () => (this.passthrough = !this.passthrough),
      },
      {
        name: "fps",
        description: "Set the playback FPS.",
        action: (fps: number) => {
          if (typeof fps !== "number") {
            console.log(
              `${new Date().toISOString()} [dmxrec] info: FPS ${
                this.playbackFPS
              }`
            );
          } else if (fps > 0 && fps < 100) {
            this.playbackFPS = fps;
          } else {
            console.log(
              `${new Date().toISOString()} [dmxrec] error: FPS must be between 1 and 100.`
            );
          }
        },
      },
      {
        name: "bk",
        description: "Blackout",
        action: () => {
          this.senders.forEach((sender) => {
            sender.fillChannels(0, 511, 0);
          });
        },
      },
    ],
  };

  constructor(sName: string, lName: string, config: PlayerConfig) {
    this.inputUnis = config.universes;
    this.outputs = config.outputs;
    this.dmxnet = new dmxlib.dmxnet({ sName, lName });

    this.dmxnet.socket.on("error", (err: any) => {
      console.error(
        `${new Date().toISOString()} [dmxrec] error: Error in socket:`,
        err
      );
    });

    this.dmxnet.logger = {
      info: (msg: string) => {
        // console.log(`${new Date().toISOString()} [dmxrec] info: ${msg}`);
      },
      warn: (msg: string) => {
        // console.log(`${new Date().toISOString()} [dmxrec] warn: ${msg}`);
      },
      error: (msg: string) => {
        // console.log(`${new Date().toISOString()} [dmxrec] error: ${msg}`);
      },
      debug: (msg: string) => {
        // console.log(`${new Date().toISOString()} [dmxrec] debug: ${msg}`);
      },
      silly: (msg: string) => {
        // console.log(`${new Date().toISOString()} [dmxrec] silly: ${msg}`);
      },
      verbose: (msg: string) => {
        // console.log(`${new Date().toISOString()} [dmxrec] verbose: ${msg}`);
      },
    };

    try {
      this.senders = this.createSenders();
      this.createListeners();
    } catch (error) {
      this.senders = [];
      console.error(
        `${new Date().toISOString()} [dmxrec] error: Error initializing:`,
        error
      );
    }

    this.checkForTimeout();
    this.shell();
  }

  private createListeners() {
    this.inputUnis.forEach((universe) => {
      const subnet = Math.floor(universe / 16);
      const localUniverse = universe % 16;
      const net = 0;

      try {
        const receiver = this.dmxnet.newReceiver({
          universe: localUniverse,
          subnet: subnet,
          net: net,
        });

        receiver.on("data", (data: Buffer) => {
          const ts = new Date();
          this.checkForTimeout();
          if (this.playing) return;
          const packet: Packet = {
            TS: new Date(),
            U: universe,
            S: subnet,
            N: net,
            data,
          };

          if (this.verbose) {
            console.log(
              `${new Date().toISOString()} [dmxrec] verbose: DATA: UNI ${universe} - SUB ${subnet} - NET ${net}`
            );
          }
          if (this.recording) {
            this.gzip!.write("," + JSON.stringify(packet), () => {
              this.gzip!.flush();
            });
          }

          if (this.passthrough) {
            this.senders.forEach((sender) => {
              if (sender.universe === universe) {
                this.transmitData(sender, data);
              }
            });
          }
        });
      } catch (error) {
        console.error(
          `${new Date().toISOString()} [dmxrec] error: Error creating listeners:`,
          error
        );
      }
    });

    console.log(
      `${new Date().toISOString()} [dmxrec] info: Listeners initialized: ${this.inputUnis.join(
        ", "
      )}`
    );
  }

  private createSenders() {
    try {
      const senders = this.outputs
        .map((output) => {
          return output.universe.map((universe) => {
            const subnet = Math.floor(universe / 16);
            const localUniverse = universe % 16;
            const net = 0;

            try {
              const sender = this.dmxnet.newSender({
                ip: output.ip,
                port: 6454,
                universe: localUniverse,
                subnet: subnet,
                net: net,
              });

              return sender;
            } catch (error) {
              console.error(
                `${new Date().toISOString()} [dmxrec] error: Error creating sender:`,
                error
              );
              return null;
            }
          });
        })
        .flat();

      senders.forEach((sender) => {
        console.log(
          `${new Date().toISOString()} [dmxrec] info: Sender initialized: ${
            sender.ip
          } - UNI ${sender.universe} - SUB ${sender.subnet} - NET ${sender.net}`
        );
      });

      return senders;
    } catch (error) {
      console.error(
        `${new Date().toISOString()} [dmxrec] error: Error creating senders:`,
        error
      );
      return [];
    }
  }

  public shell() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    this.rl.setPrompt("[dmxrec]> ");
    this.rl.prompt();

    this.rl.on("line", (input: string) => {
      const [command, ...args] = input.split(" ");
      const commandConfig = this.promptConfig.commands.find(
        (c) => c.name === command
      );

      if (commandConfig) {
        commandConfig.action(args);
      } else if (command === "") {
        // Do nothing
      } else {
        console.log(
          `${new Date().toISOString()} [dmxrec] error: ${command} - Command not found.`
        );
      }

      if (this.rl) {
        this.rl.prompt();
      }
    });
  }

  public record() {
    // Create a compressed file to store the recorded data - YYYY-MM-DD-HH-MM-SS.rec
    const date = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace("T", "-")
      .split(".")[0];
    const fileName = `${date}.dmxrec`;
    const filePath = join(__dirname, fileName);

    this.fileStream = createWriteStream(filePath, {
      flags: "w",
      encoding: "utf8",
    });

    this.gzip = createGzip();
    this.gzip.pipe(this.fileStream);

    // Write metadata as the first entry in the compressed file
    this.metadata = {
      filename: fileName,
      createdAt: new Date(),
      universes: this.inputUnis,
    };

    this.gzip.write("[");
    this.gzip.write(JSON.stringify(this.metadata), () => {
      this.gzip!.flush();
    });

    this.recording = true;
    console.log(
      `${new Date().toISOString()} [dmxrec] info - Recording started.`
    );
  }

  public close() {
    if (!this.recording) return;
    this.recording = false;
    this.gzip!.write("]");
    this.gzip!.end("\n", "utf8", () => {
      this.fileStream!.end();
    });

    console.log(
      `${new Date().toISOString()} [dmxrec] info - Recording stopped.`
    );

    console.log(
      `${new Date().toISOString()} [dmxrec] info - Saved to: ${
        this.fileStream?.path
      }`
    );
  }

  public stop() {
    this.playing = false;
    this.checkForTimeout();
  }

  public play(fileName: string) {
    // Validate file name and format
    if (!fileName) {
      console.error(
        `${new Date().toISOString()} [dmxrec] error - No file name provided.`
      );
      this.listAvailableFiles();
      return;
    }
    if (!fileName.endsWith(".dmxrec")) {
      console.error(
        `${new Date().toISOString()} [dmxrec] error - Invalid file format provided.`
      );
      this.listAvailableFiles();
      return;
    }

    // Construct file path and initiate stream read
    const filePath = fileName.startsWith("/")
      ? fileName
      : join(__dirname, fileName);
    this.readAndPlayFile(filePath);
  }

  private listAvailableFiles() {
    console.log(`${new Date().toISOString()} [dmxrec] info - Available files:`);
    const files = readdirSync(__dirname).filter((file) =>
      file.endsWith(".dmxrec")
    );
    files.forEach((file) => console.log(`\t - ${file}`));
  }

  private readAndPlayFile(filePath: string) {
    let chunks: string[] = [];

    createReadStream(filePath)
      .pipe(createGunzip())
      .on("data", (chunk) => chunks.push(chunk.toString()))
      .on("end", () => this.handleFileData(chunks))
      .on("error", (err) =>
        console.error(
          `${new Date().toISOString()} [dmxrec] error - Error parsing data:`,
          err
        )
      );
  }

  private async handleFileData(chunks: string[]) {
    const data = JSON.parse(chunks.join(""));
    if (this.playing) {
      this.playing = false; // Stop current playback if any
      await new Promise((resolve) => setTimeout(resolve, 1000));
      this.playerMeta = undefined;
      this.playerContent = undefined;
      // blackout
      this.senders.forEach((sender) => {
        sender.fillChannels(0, 511, 0);
      });
    }

    this.playerMeta = data[0]; // Assuming the first item is metadata
    this.playerContent = data
      .slice(1)
      .sort((a: Packet, b: Packet) => (a.TS < b.TS ? -1 : 1));

    console.log(
      `${new Date().toISOString()} [dmxrec] info: Finished loading data.`
    );
    console.log(`${new Date().toISOString()} [dmxrec] info: Playing...`);

    this.loop(); // Start new playback
  }

  public async loop(): Promise<void> {
    if (!this.playerContent || !this.playerContent.length) {
      console.error(
        `${new Date().toISOString()} [dmxrec] error - No data to play.`
      );
      return;
    }

    this.playing = true;

    const tempBuffer = this.playerContent.sort((a: Packet, b: Packet) =>
      a.TS < b.TS ? -1 : 1
    );

    if (!this.playing) return;

    // Calculate delays between packets
    const delays: number[] = tempBuffer.map((packet, i) => {
      if (i === 0) return 0; // First packet has no previous packet, so delay is 0
      const prevPTS = new Date(tempBuffer[i - 1].TS).getTime();
      const currentPTS = new Date(packet.TS).getTime();
      return currentPTS - prevPTS;
    });

    const duration =
      new Date(tempBuffer[tempBuffer.length - 1].TS).getTime() -
      new Date(tempBuffer[0].TS).getTime();
    const recordedUniverses = new Set(
      tempBuffer.map((packet) => packet.U + ":" + packet.S + ":" + packet.N)
    ).size;
    const frameCount = delays.filter((d) => d > 5).length;
    const fps = frameCount / (duration / 1000);
    const fadeTime = 3000; //ms
    const frameCountFade =
      Math.floor(fadeTime / (1000 / fps)) * recordedUniverses;

    const fadeInOutSteps = 300; // Number of packets for fade-in and fade-out
    const totalPackets = tempBuffer.length;
    const actualFadeSteps = Math.min(fadeInOutSteps, totalPackets / 2);

    for (let i = 0; i < actualFadeSteps; i++) {
      // Calculate the fade factor for the current step
      const fadeFactor = i / actualFadeSteps;
    
      // Fade in from black at the beginning of the clip
      const startPacketIndex = i;
      tempBuffer[startPacketIndex].data = Buffer.from(tempBuffer[startPacketIndex].data.map(value => {
        return Math.round(value * fadeFactor); // Fade in: Gradually increase from 0 to the actual value
      }));
    
      // Fade out to black at the end of the clip
      const endPacketIndex = totalPackets - actualFadeSteps + i;
      tempBuffer[endPacketIndex].data = Buffer.from(tempBuffer[endPacketIndex].data.map(value => {
        return Math.round(value * (1 - fadeFactor)); // Fade out: Gradually decrease from the actual value to 0
      }));
    }

    // Blending from end to start for a seamless loop
    // for (let i = 0; i < actualFadeSteps; i++) {
    //   const startPacketIndex = i;
    //   const endPacketIndex = totalPackets - actualFadeSteps + i;

    //   // Calculate blending factor
    //   const blendFactor = i / actualFadeSteps;

    //   // End fades to start
    //   const endToStartBlendedData = tempBuffer[endPacketIndex].data.map(
    //     (endVal, idx) => {
    //       const startVal = tempBuffer[startPacketIndex].data[idx];
    //       return Math.round(
    //         startVal * blendFactor + endVal * (1 - blendFactor)
    //       );
    //     }
    //   );

    //   // Start fades to end
    //   const startToEndBlendedData = tempBuffer[startPacketIndex].data.map(
    //     (startVal, idx) => {
    //       const endVal = tempBuffer[endPacketIndex].data[idx];
    //       return Math.round(
    //         endVal * blendFactor + startVal * (1 - blendFactor)
    //       );
    //     }
    //   );

    //   tempBuffer[startPacketIndex].data = Buffer.from(startToEndBlendedData);
    //   tempBuffer[endPacketIndex].data = Buffer.from(endToStartBlendedData);
    // }

    // Proceed with your existing loop logic to play the modified tempBuffer...

    this.rl?.prompt();

    for (let i = 0; i < tempBuffer.length; i++) {
      const ts = new Date().getTime();
      const packet = tempBuffer[i];
      const sender = this.senders.find(
        (sender) =>
          sender.universe === packet.U &&
          sender.subnet === packet.S &&
          sender.net === packet.N
      );

      if (!this.playing) break;
      if (i === tempBuffer.length - 1) i = 0;

      let data = packet.data;

      this.transmitData(sender, data);
      const ts2 = new Date().getTime();
      const pbd = delays[i] - (ts2 - ts);
      if (pbd > 2) await new Promise((resolve) => setTimeout(resolve, pbd - 2));
    }
  }

  private interpolateData(
    packet1: Packet,
    packet2: Packet,
    step: number,
    totalSteps: number
  ): Uint8Array {
    // Assuming packet data is an array of numbers
    const interpolatedData = packet1.data.map((value1, j) => {
      let value2 = packet2.data[j];

      return Math.round(value1 + (value2 - value1) * (step / totalSteps));
    });

    return interpolatedData;
  }

  public highLight(universe: number | number[]) {
    if (Array.isArray(universe)) {
      universe.forEach((uni) => this.highLightUni(uni));
    } else {
      this.highLightUni(universe);
    }
  }

  private highLightUni(universe: number) {
    // Blink the lights on the specified universe
    console.log(
      new Date().toISOString(),
      "[dmxrec] info: Blinking lights on universe: ",
      universe
    );
    this.senders.forEach(async (sender) => {
      if (sender.universe === universe) {
        for (let i = 0; i < 3; i++) {
          sender.fillChannels(0, 511, 255);
          await new Promise((resolve) => setTimeout(resolve, 500));
          sender.fillChannels(0, 511, 0);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    });
  }

  private checkForTimeout() {
    if (this.timeout) {
      clearTimeout(this.timeout);
    }

    this.timeout = setTimeout(() => {
      if (this.playing || this.recording) return;

      console.log(
        `\n${new Date().toISOString()} [dmxrec] info: Timeout detected.`
      );

      if (this.rl) {
        this.rl.prompt();
      }

      this.senders.forEach((sender) => {
        sender.fillChannels(0, 511, 0);
      });
    }, 3000);
  }

  private async transmitData(sender: any, data: Uint8Array) {
    try {
      data.forEach((value, index) => {
        sender.prepChannel(index, value);
      });

      sender.transmit();
      return;
    } catch (error) {
      console.error(
        `${new Date().toISOString()} [dmxrec] error: Error transmitting data:`,
        error
      );
    }
  }
}