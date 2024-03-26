import dmxlib from "dmxnet";
import { createWriteStream, createReadStream } from "fs";
import { createGzip, createGunzip } from "zlib";
import { join } from "path";

type RecordingMetadata = {
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

class UniverseListener {
  private dmxnet: any;
  private universes: number[];
  private recording: boolean;
  private metadata: RecordingMetadata | undefined;

  private lastPacketTS: Date = new Date();

  private fileStream: ReturnType<typeof createWriteStream> | undefined;
  private gzip: ReturnType<typeof createGzip> | undefined;

  constructor(sName: string, lName: string, universes: number[]) {
    this.universes = universes;
    this.dmxnet = new dmxlib.dmxnet({ sName, lName });
    this.recording = false;
  }

  public createListeners() {
    this.universes.forEach((universe) => {
      const subnet = Math.floor(universe / 16);
      const localUniverse = universe % 16;
      const net = 0;

      const receiver = this.dmxnet.newReceiver({
        universe: localUniverse,
        subnet: subnet,
        net: net,
      });

      receiver.on("data", (data: Buffer) => {
        const packet: Packet = {
          TS: new Date(),
          U: universe,
          S: subnet,
          N: net,
          data,
        };

        if (this.recording) {
          this.gzip!.write(JSON.stringify(packet), () => {
            this.gzip!.flush();
          });
        }
      });
    });

    console.log(`Listening to universes: ${this.universes.join(", ")}`);
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
      createdAt: new Date(),
      universes: this.universes,
    };

    this.gzip.write(JSON.stringify(this.metadata), () => {
      this.gzip!.flush();
    });

    this.recording = true;
    console.log("Recording started.");
  }

  public close() {
    if (!this.recording) return;
    this.recording = false;
    this.gzip!.end("\n", "utf8", () => {
        this.fileStream!.end();
    });
}


  public loadAndParse(fileName: string) {
    // Create a read stream from the compressed file
    const filePath = join(__dirname, fileName);
    const stream = createReadStream(filePath)
        .pipe(createGunzip()) // Pipe it through gunzip to decompress
        .on('error', (err) => console.error('Stream error:', err));

    let isFirstChunk = true;

    stream.on('data', (chunk) => {
        // Convert buffer to string
        const dataStr = chunk.toString();
        console.log(dataStr);
    });

    stream.on('end', () => {
        console.log('Finished loading data.');
    });
}

  public fps(ts: Date) {
    const diff = ts.getTime() - this.lastPacketTS.getTime();
    this.lastPacketTS = ts;
    return 1000 / diff;
  }
}

// Example usage
const universesToRecord = [0, 2, 3, 16, 17, 32];
const universeListener = new UniverseListener(
  "Safecontrol DMX",
  "Safecontrol DMX - ArtNet Transceiver",
  universesToRecord
);

universeListener.createListeners();
// universeListener.record();

universeListener.loadAndParse('2024-03-25-23-30-16.dmxrec');

// const timeout = setTimeout(() => {
//   universeListener.close();
//   clearTimeout(timeout);
// }, 3000);
