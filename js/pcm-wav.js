/** Deterministic, dependency-free PCM WAV encoding for decoded browser audio. */

const WAV_CONTENT_TYPE = "audio/wav";
const MAX_RIFF_DATA_BYTES = 0xffffffff - 36;

function assertAudioBufferLike(audioBuffer) {
  const channels = Number(audioBuffer?.numberOfChannels);
  const frames = Number(audioBuffer?.length);
  const sampleRate = Number(audioBuffer?.sampleRate);
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
    throw new TypeError("AudioBuffer must contain between 1 and 8 channels.");
  }
  if (!Number.isInteger(frames) || frames < 1) {
    throw new TypeError("AudioBuffer must contain at least one frame.");
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new TypeError("AudioBuffer sampleRate is unsupported.");
  }
  if (typeof audioBuffer.getChannelData !== "function") {
    throw new TypeError("AudioBuffer.getChannelData is required.");
  }
  return { channels, frames, sampleRate: Math.round(sampleRate) };
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function quantize(sample, bitDepth) {
  const value = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
  if (bitDepth === 16) {
    return Math.round(value < 0 ? value * 0x8000 : value * 0x7fff);
  }
  return Math.round(value < 0 ? value * 0x800000 : value * 0x7fffff);
}

function writeInt24(view, offset, value) {
  const unsigned = value < 0 ? value + 0x1000000 : value;
  view.setUint8(offset, unsigned & 0xff);
  view.setUint8(offset + 1, (unsigned >>> 8) & 0xff);
  view.setUint8(offset + 2, (unsigned >>> 16) & 0xff);
}

/**
 * Encode an AudioBuffer-compatible object as interleaved PCM RIFF/WAVE.
 * 24-bit PCM is the default: broadly supported by FFmpeg/Demucs and lossless
 * for practical browser capture quality without float-container ambiguity.
 */
export function encodeAudioBufferToWav(audioBuffer, options = {}) {
  const { channels, frames, sampleRate } = assertAudioBufferLike(audioBuffer);
  const bitDepth = Number(options.bitDepth ?? 24);
  if (![16, 24].includes(bitDepth)) {
    throw new RangeError("PCM WAV bitDepth must be 16 or 24.");
  }

  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  if (!Number.isSafeInteger(dataBytes) || dataBytes > MAX_RIFF_DATA_BYTES) {
    throw new RangeError("Decoded audio is too large for a RIFF/WAVE file.");
  }

  const channelData = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const samples = audioBuffer.getChannelData(channel);
    if (!samples || Number(samples.length) < frames) {
      throw new TypeError(`AudioBuffer channel ${channel} is shorter than AudioBuffer.length.`);
    }
    channelData.push(samples);
  }

  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // WAVE_FORMAT_PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = quantize(channelData[channel][frame], bitDepth);
      if (bitDepth === 16) view.setInt16(offset, value, true);
      else writeInt24(view, offset, value);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

export function createPcmWavFile(audioBuffer, options = {}) {
  if (typeof File !== "function") {
    throw new TypeError("File is not available in this browser.");
  }
  const rawName = String(options.fileName || "youtube-capture.wav")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .trim();
  const fileName = `${rawName || "youtube-capture"}`.replace(/\.wav$/i, "") + ".wav";
  const bitDepth = Number(options.bitDepth ?? 24);
  const payload = encodeAudioBufferToWav(audioBuffer, { bitDepth });
  return new File([payload], fileName, {
    type: WAV_CONTENT_TYPE,
    lastModified: Number.isFinite(Number(options.lastModified)) ? Number(options.lastModified) : 0
  });
}

export const PCM_WAV_CONTENT_TYPE = WAV_CONTENT_TYPE;
