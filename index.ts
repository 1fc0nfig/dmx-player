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

type PlayerConfig = {
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

class DMXRecorder {
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
        action: () => recorder.record(),
      },
      {
        name: "stop",
        description: "Stop recording DMX data.",
        action: () => recorder.close(),
      },
      {
        name: "play",
        description: "Load and parse a recorded file.",
        action: (filename: string[]) => recorder.play(filename[0]),
      },
      {
        name: "end",
        description: "Ends playback.",
        action: () => (this.playing = false),
      },
      {
        name: "highlight",
        description: "Blink lights on the specified universe.",
        action: (universe: number) => recorder.highLight(universe),
      },
      {
        name: "passthrough",
        description: "Toggle passthrough mode.",
        action: () => (this.passthrough = !this.passthrough),
      },
      {
        name: "fps",
        description: "Set the playback FPS.",
        action: (fps: number) => (this.playbackFPS = fps),
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
      }
    };

    console.log(this.dmxnet.__proto__);
    

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
              `${new Date().toISOString()} [dmxrec] verbose: ${
                receiver.ip
              } - UNI ${universe} - SUB ${subnet} - NET ${net} - ${Array.from(
                data
              ).join(", ")}`
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
                this.transmitData(sender, Array.from(data));
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

  private handleFileData(chunks: string[]) {
    const data = JSON.parse(chunks.join(""));
    this.playerMeta = data[0]; // Assuming the first item is metadata
    this.playerContent = data
      .slice(1)
      .sort((a: Packet, b: Packet) => (a.TS < b.TS ? -1 : 1));

    console.log(
      `${new Date().toISOString()} [dmxrec] info: Finished loading data.`
    );
    console.log(`${new Date().toISOString()} [dmxrec] info: Playing...`);

    if (this.playing) {
      this.playing = false; // Stop current playback if any
    }

    this.loop(); // Start new playback
  }

  public async loop(): Promise<void> {
    if (!this.playerContent || !this.playerContent.length) {
      console.error(
        `${new Date().toISOString()} [dmxrec] error - No data to play.`
      );
      return;
    }

    const recordedUniverses = new Set(
      this.playerContent.map((packet) => `${packet.U}:${packet.S}:${packet.N}`)
    );
    this.frames = this.prepareFrames(recordedUniverses);
    console.log(this.frames);

    this.rl?.prompt();
    this.playing = true;

    // Assume framesForFade is even for simplicity; adjust logic if needed for odd numbers
    const framesForFade = this.playbackFPS * 1; // 1 second of fade
    const endFrames = this.getCurrentClipEndFrames(framesForFade / 2);
    const startFrames = this.getNewClipStartFrames(
      this.playerContent,
      framesForFade / 2
    );
    let interpolatedFrames = [];

    // Generate interpolated frames
    for (let i = 0; i < framesForFade; i++) {
      let frame = this.interpolateFrames(
        endFrames[i % endFrames.length],
        startFrames[i % startFrames.length],
        i,
        framesForFade
      );
      interpolatedFrames.push(frame);
    }

    // Split the interpolated frames into two halves
    const firstHalf = interpolatedFrames.slice(
      0,
      interpolatedFrames.length / 2
    );

    const secondHalf = interpolatedFrames.slice(interpolatedFrames.length / 2);

    // Replace the start of this.frames with the second half of interpolated frames
    for (let i = 0; i < secondHalf.length; i++) {
      this.frames[i] = secondHalf[i];
    }

    // Replace the end of this.frames with the first half of interpolated frames
    for (let i = 0; i < firstHalf.length; i++) {
      this.frames[this.frames.length - firstHalf.length + i] = firstHalf[i];
    }

    // Continue with adjusted this.frames
    while (this.playing && this.frames.length > 0) {
      for (const frame of this.frames) {
        if (!this.playing) break;
        await this.processAndDelay(frame);
      }
    }
  }

  private prepareFrames(recordedUniverses: Set<string>): Array<Frame> {
    let frames: Array<Frame> = [];

    if (!this.playerContent || !this.playerContent.length) return [];
    for (
      let i = 0;
      i < this.playerContent.length;
      i += recordedUniverses.size
    ) {
      const framePackets = this.playerContent.slice(
        i,
        i + recordedUniverses.size
      );
      frames.push({ delay: 0, packet: framePackets });
    }

    return frames;
  }

  private processFrame(frame: Frame): void {
    frame.packet.forEach((packet) => {
      if (!packet) return;
      const senders = this.senders.filter(
        (sender) =>
          sender.universe === packet.U &&
          sender.subnet === packet.N &&
          sender.net === packet.N
      );
      senders.forEach((sender) =>
        this.transmitData(sender, Array.from(packet.data))
      );
    });
  }

  private getCurrentClipEndFrames(framesForFade: number): Frame[] {
    // Directly return the last 'framesForFade' this.frames, or whatever is available if fewer.
    return this.frames.slice(-framesForFade);
  }

  private getNewClipStartFrames(
    newClip: Packet[],
    framesForFade: number
  ): Frame[] {
    // Use a temporary variable for new this.frames to avoid modifying playerContent
    const tempFrames = this.prepareFramesForClip(newClip);
    return tempFrames.slice(0, framesForFade);
  }

  private prepareFramesForClip(clip: Packet[]): Frame[] {
    const recordedUniverses = new Set(
      clip.map((packet) => `${packet.U}:${packet.S}:${packet.N}`)
    );
    return this.prepareFrames(recordedUniverses);
  }

  private interpolateFrames(
    frame1: Frame,
    frame2: Frame,
    step: number,
    totalSteps: number
  ): Frame {
    let interpolatedFrame: Frame = { delay: 0, packet: [] };

    for (let i = 0; i < frame1.packet.length; i++) {
      let packet1 = frame1.packet[i];
      let packet2 = frame2.packet.find(
        (p) => p.U === packet1.U && p.S === packet1.S && p.N === packet1.N
      );

      if (!packet2) {
        // If there's no matching packet in frame2, you might want to handle this case,
        // e.g., by skipping this packet or using packet1's data directly.
        continue;
      }

      let interpolatedPacket: Packet = {
        TS: new Date(), // or some interpolation of TS if needed
        U: packet1.U,
        S: packet1.S,
        N: packet1.N,
        data: Buffer.alloc(packet1.data.length),
      };

      for (let j = 0; j < packet1.data.length; j++) {
        // Linear interpolation of DMX channel values, ensuring the result is rounded
        // and remains within the 0-255 range valid for DMX data.
        let value1 = packet1.data[j];
        let value2 = packet2.data[j];
        interpolatedPacket.data[j] = Math.round(
          value1 + (value2 - value1) * (step / totalSteps)
        );
      }

      interpolatedFrame.packet.push(interpolatedPacket);
    }

    return interpolatedFrame;
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

  private transmitData(sender: any, data: number[]) {
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

  private async processAndDelay(frame: Frame): Promise<void> {
    const frameStart = new Date().getTime();
    this.processFrame(frame);
    const frameProcessingTime = new Date().getTime() - frameStart;

    const targetFrameDuration = 1000 / this.playbackFPS;
    const delay = Math.max(0, targetFrameDuration - frameProcessingTime);

    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

// Example usage
const config: PlayerConfig = {
  universes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  outputs: [
    {
      ip: "192.168.0.21",
      universe: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    },
    {
      ip: "192.168.0.20",
      universe: [32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44],
    },
  ],
};

const recorder = new DMXRecorder(
  "Safecontrol DMX",
  "Safecontrol DMX - ArtNet Transceiver",
  config
);

recorder.play("2024-04-05-19-47-40.dmxrec");
