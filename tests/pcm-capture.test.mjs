import assert from "node:assert/strict";
import test from "node:test";

import { audioBufferSignalStats } from "../js/pcm-capture.js";

function fakeBuffer(channels) {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length || 0,
    getChannelData(index) { return channels[index]; }
  };
}

test("capture validation rejects an empty or silent shared tab", () => {
  assert.equal(audioBufferSignalStats(null).silent, true);
  const silence = fakeBuffer([new Float32Array(4096), new Float32Array(4096)]);
  assert.deepEqual(audioBufferSignalStats(silence), { peak: 0, rms: 0, silent: true });
});

test("capture validation recognizes a real audio signal", () => {
  const signal = new Float32Array(48000);
  for (let index = 0; index < signal.length; index += 1) {
    signal[index] = Math.sin((index / 48000) * Math.PI * 2 * 440) * 0.2;
  }
  const stats = audioBufferSignalStats(fakeBuffer([signal, signal]));
  assert.equal(stats.silent, false);
  assert.ok(stats.peak > 0.19);
  assert.ok(stats.rms > 0.1);
});
