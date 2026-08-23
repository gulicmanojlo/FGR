export const AUDIO_IMPORT_MAX_BYTES = 512 * 1024 * 1024;

export const AUDIO_IMPORT_FORMATS = Object.freeze({
  mp3: { label: "MP3", mimes: ["audio/mpeg", "audio/mp3"] },
  wav: { label: "WAV", mimes: ["audio/wav", "audio/x-wav", "audio/wave"] },
  flac: { label: "FLAC", mimes: ["audio/flac", "audio/x-flac"] },
  m4a: { label: "M4A", mimes: ["audio/mp4", "audio/x-m4a", "audio/m4a"] },
  aif: { label: "AIFF", mimes: ["audio/aiff", "audio/x-aiff"] },
  aiff: { label: "AIFF", mimes: ["audio/aiff", "audio/x-aiff"] }
});

export const AUDIO_IMPORT_ACCEPT = [
  ".mp3",
  ".wav",
  ".flac",
  ".m4a",
  ".aif",
  ".aiff",
  ...new Set(Object.values(AUDIO_IMPORT_FORMATS).flatMap((format) => format.mimes))
].join(",");

function fileExtension(name) {
  const match = String(name || "").trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

export function importedAudioFormat(fileOrName) {
  const extension = fileExtension(typeof fileOrName === "string" ? fileOrName : fileOrName?.name);
  return AUDIO_IMPORT_FORMATS[extension] || null;
}

export function importedAudioBadge(fileOrName) {
  return importedAudioFormat(fileOrName)?.label || "AUDIO";
}

export function validateImportedAudioFile(file, options = {}) {
  if (!file) return { valid: false, code: "missing", message: "Izaberi audio fajl." };
  const maxBytes = Math.max(1, Number(options.maxBytes) || AUDIO_IMPORT_MAX_BYTES);
  const format = importedAudioFormat(file);
  if (!format) {
    return {
      valid: false,
      code: "format",
      message: "Podržani su MP3, WAV, FLAC, M4A i AIFF fajlovi."
    };
  }
  if (Number(file.size) > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    return {
      valid: false,
      code: "size",
      message: `Audio fajl je veći od dozvoljenih ${maxMb} MB.`
    };
  }
  return { valid: true, code: "ok", format: format.label, extension: fileExtension(file.name) };
}
