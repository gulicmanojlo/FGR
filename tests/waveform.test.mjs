import assert from "node:assert/strict";

import { buildWaveformPath, createWaveformPath, extractWaveformPeaks } from "../js/waveform.js";

function makeBuffer(channels) {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length || 0,
    getChannelData(index) {
      return channels[index];
    }
  };
}

const sampleCount = 48000;
const signal = new Float32Array(sampleCount);
for (let index = 0; index < signal.length; index += 1) {
  const envelope = index < sampleCount / 2 ? 0.15 : 0.8;
  signal[index] = Math.sin(index * 0.08) * envelope;
}

const peaks = extractWaveformPeaks(makeBuffer([signal]), { bins: 64 });
assert.equal(peaks.length, 64);
assert.ok(peaks.every((value) => value >= 0 && value <= 1));
assert.ok(Math.max(...peaks.slice(32)) > Math.max(...peaks.slice(0, 32)) * 1.8);

const path = createWaveformPath(makeBuffer([signal]), { bins: 64 });
assert.match(path, /^M /);
assert.match(path, / Z$/);
assert.ok(path.length > 500);

const emptyPath = buildWaveformPath([]);
assert.match(emptyPath, /^M 0 47 L 1000 47 L 1000 49 L 0 49 Z$/);
assert.deepEqual(extractWaveformPeaks(null), []);
assert.deepEqual(extractWaveformPeaks(makeBuffer([])), []);

console.log("waveform tests passed");
