import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_IMPORT_ACCEPT,
  AUDIO_IMPORT_MAX_BYTES,
  importedAudioBadge,
  validateImportedAudioFile
} from "../js/audio-import.js";

test("accepts lossless and common source formats", () => {
  for (const [name, badge] of [
    ["pesma.mp3", "MP3"],
    ["master.WAV", "WAV"],
    ["mix.flac", "FLAC"],
    ["telefon.m4a", "M4A"],
    ["studio.aiff", "AIFF"]
  ]) {
    const result = validateImportedAudioFile({ name, size: 1024, type: "" });
    assert.equal(result.valid, true, name);
    assert.equal(importedAudioBadge(name), badge);
  }
  assert.match(AUDIO_IMPORT_ACCEPT, /\.wav/);
  assert.match(AUDIO_IMPORT_ACCEPT, /audio\/flac/);
});

test("rejects unsupported and oversized files with a useful reason", () => {
  assert.equal(validateImportedAudioFile({ name: "video.mp4", size: 10 }).code, "format");
  const huge = validateImportedAudioFile({ name: "master.wav", size: AUDIO_IMPORT_MAX_BYTES + 1 });
  assert.equal(huge.code, "size");
  assert.match(huge.message, /512 MB/);
});
