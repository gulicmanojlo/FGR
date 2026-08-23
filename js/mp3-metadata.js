const DEFAULT_MAX_DATA_URL_LENGTH = 90000;
const MAX_ID3_TAG_BYTES = 16 * 1024 * 1024;
const MUSICAL_KEY_SUFFIX = /^(?:[a-h](?:#|b|is|es)?)(?:\s*-?\s*(?:m|mol|dur|min|minor|maj|major))?$/i;

/**
 * Common downloads append non-musical tags such as "(Audio 2001)" after the
 * artist and title. Only a real key token may populate the tonalitet field.
 */
export function parseImportedAudioFilename(filename) {
  const stem = String(filename || "").replace(/\.mp3$/i, "").trim();
  const parts = stem.split(" - ").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const possibleKey = parts.slice(2).join(" - ").trim();
    return {
      title: `${parts[0]} - ${parts[1]}`,
      key: MUSICAL_KEY_SUFFIX.test(possibleKey) ? possibleKey : ""
    };
  }
  return { title: stem || "Nova pesma", key: "" };
}

function readSynchsafe(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return -1;
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  const fourth = bytes[offset + 3];
  if ((first | second | third | fourth) & 0x80) return -1;
  return (first << 21) | (second << 14) | (third << 7) | fourth;
}

function readUint24(bytes, offset) {
  if (offset < 0 || offset + 3 > bytes.length) return -1;
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function readUint32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return -1;
  return (
    (bytes[offset] * 0x1000000) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function ascii(bytes, offset, length) {
  let value = "";
  const end = Math.min(bytes.length, offset + length);
  for (let index = offset; index < end; index += 1) value += String.fromCharCode(bytes[index]);
  return value;
}

function removeUnsynchronization(bytes) {
  const output = new Uint8Array(bytes.length);
  let write = 0;
  for (let read = 0; read < bytes.length; read += 1) {
    output[write] = bytes[read];
    write += 1;
    if (bytes[read] === 0xff && bytes[read + 1] === 0x00) read += 1;
  }
  return output.subarray(0, write);
}

function findTerminator(bytes, offset, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let index = offset; index + 1 < bytes.length; index += 2) {
      if (bytes[index] === 0 && bytes[index + 1] === 0) return index + 2;
    }
    return -1;
  }
  const terminator = bytes.indexOf(0, offset);
  return terminator < 0 ? -1 : terminator + 1;
}

function detectImageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  return "";
}

function normalizeImageMime(value, imageBytes) {
  const mime = String(value || "").trim().toLowerCase();
  if (["image/jpeg", "image/jpg", "jpg", "jpeg"].includes(mime)) return "image/jpeg";
  if (["image/png", "png"].includes(mime)) return "image/png";
  if (["image/gif", "gif"].includes(mime)) return "image/gif";
  if (["image/webp", "webp"].includes(mime)) return "image/webp";
  return detectImageMime(imageBytes);
}

function parsePictureFrame(payload, isLegacyPic) {
  if (!(payload instanceof Uint8Array) || payload.length < (isLegacyPic ? 6 : 5)) return null;
  const encoding = payload[0];
  let cursor = 1;
  let declaredMime = "";

  if (isLegacyPic) {
    declaredMime = ascii(payload, cursor, 3);
    cursor += 3;
  } else {
    const mimeEnd = payload.indexOf(0, cursor);
    if (mimeEnd < cursor) return null;
    declaredMime = ascii(payload, cursor, mimeEnd - cursor);
    cursor = mimeEnd + 1;
  }

  if (cursor >= payload.length) return null;
  cursor += 1; // Picture type.
  const imageStart = findTerminator(payload, cursor, encoding);
  if (imageStart < 0 || imageStart >= payload.length) return null;

  const image = payload.subarray(imageStart);
  const mime = normalizeImageMime(declaredMime, image);
  return mime && image.length ? { mime, image } : null;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  if (typeof btoa === "function") return btoa(binary);
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  return "";
}

function extractPictureFromTag(tag, version, flags) {
  let cursor = 10;
  const tagEnd = tag.length;

  if (flags & 0x40) {
    if (version === 3) {
      const extendedSize = readUint32(tag, cursor);
      if (extendedSize < 0) return null;
      cursor += 4 + extendedSize;
    } else if (version === 4) {
      const extendedSize = readSynchsafe(tag, cursor);
      if (extendedSize < 4) return null;
      cursor += extendedSize;
    }
  }

  while (cursor < tagEnd) {
    const legacy = version === 2;
    const headerSize = legacy ? 6 : 10;
    if (cursor + headerSize > tagEnd) break;

    const id = ascii(tag, cursor, legacy ? 3 : 4);
    if (!id.replace(/\0/g, "")) break;
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;

    const frameSize = legacy
      ? readUint24(tag, cursor + 3)
      : version === 4 ? readSynchsafe(tag, cursor + 4) : readUint32(tag, cursor + 4);
    if (frameSize <= 0 || cursor + headerSize + frameSize > tagEnd) break;

    const isPicture = id === "APIC" || id === "PIC";
    if (isPicture) {
      let payload = tag.subarray(cursor + headerSize, cursor + headerSize + frameSize);
      if (!legacy) {
        const formatFlags = tag[cursor + 9];
        const compressed = version === 3 ? Boolean(formatFlags & 0x80) : Boolean(formatFlags & 0x08);
        const encrypted = version === 3 ? Boolean(formatFlags & 0x40) : Boolean(formatFlags & 0x04);
        if (compressed || encrypted) return null;
        if ((version === 3 && (formatFlags & 0x20)) || (version === 4 && (formatFlags & 0x40))) {
          payload = payload.subarray(1);
        }
        if (version === 4 && (formatFlags & 0x01)) payload = payload.subarray(4);
        if ((flags & 0x80) || (version === 4 && (formatFlags & 0x02))) {
          payload = removeUnsynchronization(payload);
        }
      } else if (flags & 0x80) {
        payload = removeUnsynchronization(payload);
      }
      return parsePictureFrame(payload, legacy);
    }
    cursor += headerSize + frameSize;
  }
  return null;
}

/**
 * Reads a small APIC/PIC cover from an MP3 ID3v2 tag. Invalid, unsupported or
 * oversized metadata deliberately resolves to an empty string so importing the
 * audio never depends on optional artwork.
 */
export async function extractEmbeddedArtwork(file, options = {}) {
  try {
    if (!file || typeof file.slice !== "function") return "";
    const header = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (header.length < 10 || ascii(header, 0, 3) !== "ID3") return "";

    const version = header[3];
    if (version < 2 || version > 4) return "";
    const tagPayloadSize = readSynchsafe(header, 6);
    if (tagPayloadSize <= 0 || tagPayloadSize > MAX_ID3_TAG_BYTES) return "";

    const tag = new Uint8Array(await file.slice(0, Math.min(file.size || Infinity, tagPayloadSize + 10)).arrayBuffer());
    if (tag.length < tagPayloadSize + 10) return "";
    const picture = extractPictureFromTag(tag, version, header[5]);
    if (!picture) return "";

    const maxDataUrlLength = Math.max(128, Number(options.maxDataUrlLength) || DEFAULT_MAX_DATA_URL_LENGTH);
    const prefix = `data:${picture.mime};base64,`;
    const maxImageBytes = Math.floor((maxDataUrlLength - prefix.length) * 3 / 4);
    if (maxImageBytes <= 0 || picture.image.length > maxImageBytes) return "";

    const base64 = bytesToBase64(picture.image);
    const result = base64 ? `${prefix}${base64}` : "";
    return result.length <= maxDataUrlLength ? result : "";
  } catch {
    return "";
  }
}
