import dmxlib from "dmxnet";
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

  private fps: number = 35;
  private playing: boolean = false;
  private recording: boolean = false;
  private passthrough: boolean = true;
  private metadata: RecordingMetadata | undefined;

  private playerMeta: RecordingMetadata | undefined;
  private playerContent: Packet[] | undefined;

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
        action: (filename: string) => recorder.play(filename),
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
        action: (fps: number) => (this.fps = fps),
      },
      {
        name: "bk",
        description: "Blackout",
        action: () => {
          this.senders.forEach((sender) => {
            sender.fillChannels(0, 511, 0);
          });
        },
      }
    ],
  };

  constructor(sName: string, lName: string, config: PlayerConfig) {
    this.inputUnis = config.universes;
    this.outputs = config.outputs;
    this.dmxnet = new dmxlib.dmxnet({ sName, lName });

    this.senders = this.createSenders();
    this.createListeners();

    this.checkForTimeout();
    this.shell();
  }

  private createListeners() {
    this.inputUnis.forEach((universe) => {
      const subnet = Math.floor(universe / 16);
      const localUniverse = universe % 16;
      const net = 0;

      const receiver = this.dmxnet.newReceiver({
        universe: localUniverse,
        subnet: subnet,
        net: net,
      });

      receiver.on("data", (data: Buffer) => {
        this.checkForTimeout();
        if (this.playing) return;
        if (this.recording) {
          const packet: Packet = {
            TS: new Date(),
            U: universe,
            S: subnet,
            N: net,
            data,
          };
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

            return this.dmxnet.newSender({
              ip: output.ip,
              port: 6454,
              universe: localUniverse,
              subnet: subnet,
              net: net,
            });
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
    if (Array.isArray(fileName)) {
      fileName = fileName[0];
    }

    if (!fileName) {
      console.error(
        `${new Date().toISOString()} [dmxrec] error - No file name provided.`
      );

      console.log(
        `${new Date().toISOString()} [dmxrec] info - Available files:`
      );

      const files = readdirSync(__dirname);
      files.forEach((file) => {
        if (file.endsWith(".dmxrec")) {
          console.log(`\t - ${file}`);
        }
      });
      return;
    } else if (!fileName.endsWith(".dmxrec")) {
      console.error(
        `${new Date().toISOString()} [dmxrec] error - Invalid file format.`
      );
      return;
    }

    const filePath = fileName.startsWith("/")
      ? fileName
      : join(__dirname, fileName);
    let chunks: string[] = new Array();
    const stream = createReadStream(filePath)
      .pipe(createGunzip())
      .on("error", (err) => {
        console.error(
          `${new Date().toISOString()} [dmxrec] error - Error parsing data:`,
          err
        );
      });

    stream.on("data", (chunk) => {
      chunks.push(chunk.toString());
    });

    stream.on("end", () => {
      const data = JSON.parse(chunks.join(""));
      this.playerMeta = data[0];
      this.playerContent = data.slice(1).sort((a: Packet, b: Packet) => {
        return a.TS < b.TS ? -1 : 1;
      });

      console.log(
        `${new Date().toISOString()} [dmxrec] info: Finished loading data.`
      );

      console.log(`${new Date().toISOString()} [dmxrec] info: Playing...`);
      this.loop();
    });
  }

  public async loop() {
    if (!this.playerContent || !this.playerMeta) {
      console.error(
        `${new Date().toISOString()} [dmxrec] error - No data to play.`
      );
      return;
    }

    const duration = new Date(this.playerContent[this.playerContent.length - 1].TS).getTime() - new Date(this.playerContent[0].TS).getTime();
    const recordedUniverses = new Set(this.playerContent.map((packet) => packet.U+":"+packet.S+":"+packet.N));

    let frames = new Array<Frame>();
    // group packets by size of recordedUniverses
    for (let i = 0; i < this.playerContent.length; i+=recordedUniverses.size) {
      const frame: Frame = {
        delay: 0,
        packet: []
      }
      for (let j = i; j < i + recordedUniverses.size; j++) {
        frame.packet.push(this.playerContent[j])
      }

      // filter undefined packets
      frame.packet = frame.packet.filter((packet) => packet !== undefined);
      frames.push(frame)      
    }

    this.rl?.prompt();

    this.playing = true;

    while (this.playing) {
      for (let i = 0; i < frames.length; i++) {
        if (!this.playing) break;
        const frameStart = new Date().getTime();
        const frame = frames[i];
        frame.packet.forEach((packet) => {
          if (!packet) return;
          const senders = this.senders.filter((sender) => sender.universe === packet.U);
          senders.forEach((sender) =>
            this.transmitData(sender, Array.from(packet.data))
          );
        });
        
        await new Promise((resolve) => setTimeout(resolve, 1000 / this.fps));
      }
    }
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

recorder.play("2024-04-04-23-07-07.dmxrec");

