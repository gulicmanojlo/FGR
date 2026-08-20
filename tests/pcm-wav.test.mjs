import assert from "node:assert/strict";

import { createPcmWavFile, encodeAudioBufferToWav } from "../js/pcm-wav.js";

function audioBuffer(channels, sampleRate = 48000) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    getChannelData(index) { return channels[index]; }
  };
}

function ascii(view, offset, length) {
  return String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint8(offset + index)));
}

function int24(view, offset) {
  const raw = view.getUint8(offset)
    | (view.getUint8(offset + 1) << 8)
    | (view.getUint8(offset + 2) << 16);
  return raw & 0x800000 ? raw - 0x1000000 : raw;
}

const source = audioBuffer([
  new Float32Array([-1, 0, 1]),
  new Float32Array([0.5, -0.5, Number.NaN])
]);
const encoded = encodeAudioBufferToWav(source);
const view = new DataView(encoded);
assert.equal(ascii(view, 0, 4), "RIFF");
assert.equal(ascii(view, 8, 4), "WAVE");
assert.equal(ascii(view, 12, 4), "fmt ");
assert.equal(view.getUint16(20, true), 1);
assert.equal(view.getUint16(22, true), 2);
assert.equal(view.getUint32(24, true), 48000);
assert.equal(view.getUint16(32, true), 6);
assert.equal(view.getUint16(34, true), 24);
assert.equal(ascii(view, 36, 4), "data");
assert.equal(view.getUint32(40, true), 18);
assert.equal(encoded.byteLength, 62);
assert.deepEqual(
  Array.from({ length: 6 }, (_, index) => int24(view, 44 + index * 3)),
  [-8388608, 4194304, 0, -4194304, 8388607, 0]
);

const secondPass = encodeAudioBufferToWav(source);
assert.deepEqual(new Uint8Array(secondPass), new Uint8Array(encoded));

const pcm16 = encodeAudioBufferToWav(audioBuffer([new Float32Array([-1, 1])], 44100), { bitDepth: 16 });
const pcm16View = new DataView(pcm16);
assert.equal(pcm16View.getUint16(34, true), 16);
assert.equal(pcm16View.getInt16(44, true), -32768);
assert.equal(pcm16View.getInt16(46, true), 32767);

const file = createPcmWavFile(source, { fileName: "Luis: test.WAV", lastModified: 123 });
assert.equal(file.name, "Luis- test.wav");
assert.equal(file.type, "audio/wav");
assert.equal(file.lastModified, 123);
assert.equal(file.size, encoded.byteLength);

assert.throws(() => encodeAudioBufferToWav(source, { bitDepth: 32 }), /16 or 24/);
assert.throws(
  () => encodeAudioBufferToWav({ numberOfChannels: 0, length: 1, sampleRate: 48000 }),
  /between 1 and 8/
);

console.log("pcm-wav tests passed");
