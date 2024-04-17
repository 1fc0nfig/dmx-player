import { PlayerConfig, DMXRecorder } from ".";

// Example usage
const config: PlayerConfig = {
  universes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33],
  outputs: [
    {
      ip: "192.168.2.20",
      universe: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    },
    {
      ip: "192.168.2.22",
      universe: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    },
    {
      ip: "192.168.2.23",
      universe: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29],
    },
  ],
};

const recorder = new DMXRecorder(
  "Safecontrol DMX",
  "Safecontrol DMX - ArtNet Transceiver",
  config
);

try {
  recorder.play("/home/pi/dmx-player/final.dmxrec")
} catch (e) {
  console.error("File not found");
}