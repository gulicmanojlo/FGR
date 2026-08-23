import assert from "node:assert/strict";

import { extractEmbeddedArtwork, parseImportedAudioFilename } from "../js/mp3-metadata.js";

function synchsafe(value) {
  return [
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f
  ];
}

function uint32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function uint24(value) {
  return [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function makeV23Mp3(image, mime = "image/jpeg") {
  const payload = Uint8Array.from([
    0,
    ...Buffer.from(mime, "ascii"), 0,
    3,
    0,
    ...image
  ]);
  const frame = Uint8Array.from([
    ...Buffer.from("APIC", "ascii"),
    ...uint32(payload.length),
    0, 0,
    ...payload
  ]);
  return new Blob([Uint8Array.from([
    ...Buffer.from("ID3", "ascii"),
    3, 0, 0,
    ...synchsafe(frame.length),
    ...frame,
    0xff, 0xfb, 0x90, 0x64
  ])], { type: "audio/mpeg" });
}

function makeV22Mp3(image) {
  const payload = Uint8Array.from([0, ...Buffer.from("PNG", "ascii"), 3, 0, ...image]);
  const frame = Uint8Array.from([...Buffer.from("PIC", "ascii"), ...uint24(payload.length), ...payload]);
  return new Blob([Uint8Array.from([
    ...Buffer.from("ID3", "ascii"), 2, 0, 0, ...synchsafe(frame.length), ...frame
  ])], { type: "audio/mpeg" });
}

function makeV24UnsynchronizedMp3(rawImage) {
  const payload = Uint8Array.from([0, ...Buffer.from("image/jpeg", "ascii"), 0, 3, 0, ...rawImage]);
  const frame = Uint8Array.from([
    ...Buffer.from("APIC", "ascii"), ...synchsafe(payload.length), 0, 0x02, ...payload
  ]);
  return new Blob([Uint8Array.from([
    ...Buffer.from("ID3", "ascii"), 4, 0, 0, ...synchsafe(frame.length), ...frame
  ])], { type: "audio/mpeg" });
}

const tinyJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3, 0xff, 0xd9]);
assert.equal(
  await extractEmbeddedArtwork(makeV23Mp3(tinyJpeg)),
  `data:image/jpeg;base64,${Buffer.from(tinyJpeg).toString("base64")}`
);

const tinyPng = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
assert.equal(
  await extractEmbeddedArtwork(makeV22Mp3(tinyPng)),
  `data:image/png;base64,${Buffer.from(tinyPng).toString("base64")}`
);

const unsynchronizedJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0xdb, 1, 2, 0xff, 0xd9]);
const restoredJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 0xff, 0xd9]);
assert.equal(
  await extractEmbeddedArtwork(makeV24UnsynchronizedMp3(unsynchronizedJpeg)),
  `data:image/jpeg;base64,${Buffer.from(restoredJpeg).toString("base64")}`
);

assert.equal(await extractEmbeddedArtwork(new Blob([tinyJpeg], { type: "audio/mpeg" })), "");
assert.equal(await extractEmbeddedArtwork(new Blob([Buffer.from("ID3\x03\x00\x00\x7f\x7f\x7f\x7f")])), "");

const oversizedImage = new Uint8Array(200);
oversizedImage.set(tinyJpeg.subarray(0, 3));
assert.equal(await extractEmbeddedArtwork(makeV23Mp3(oversizedImage), { maxDataUrlLength: 128 }), "");

const brokenFile = {
  slice() {
    return { arrayBuffer: async () => { throw new Error("read failed"); } };
  }
};
assert.equal(await extractEmbeddedArtwork(brokenFile), "");

assert.deepEqual(
  parseImportedAudioFilename("Luis - Sve se osim tuge deli - Amol.mp3"),
  { title: "Luis - Sve se osim tuge deli", key: "Amol" }
);
assert.deepEqual(
  parseImportedAudioFilename("Sasa Matic - Maskara - (Audio 2001).mp3"),
  { title: "Sasa Matic - Maskara", key: "" }
);
assert.deepEqual(
  parseImportedAudioFilename("Artist - Song - c-mol.mp3"),
  { title: "Artist - Song", key: "c-mol" }
);

console.log("mp3-metadata tests passed");
