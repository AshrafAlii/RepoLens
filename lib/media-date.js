"use strict";

/**
 * Extract the "own" creation date of a media file from its bytes.
 *
 * Photos: EXIF DateTimeOriginal / DateTimeDigitized / DateTime (JPEG, PNG, WebP).
 * Videos: the QuickTime/MP4 movie header (`mvhd`) creation time.
 *
 * Returns an ISO string, or null when the file carries no usable date.
 */

function exifDateToIso(value) {
  if (!value) return null;
  const match = String(value).match(
    /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (year < 1970 || year > 2100) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;

  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// Parses a TIFF/EXIF block that starts at `start` in `buf`.
function tiffDate(buf, start) {
  if (!Buffer.isBuffer(buf) || start < 0 || start + 8 > buf.length) return null;

  const order = buf.toString("ascii", start, start + 2);
  const little = order === "II";
  if (!little && order !== "MM") return null;

  const u16 = (offset) =>
    little ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
  const u32 = (offset) =>
    little ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);

  if (u16(start + 2) !== 42) return null;

  const ifd0 = start + u32(start + 4);
  if (ifd0 + 2 > buf.length) return null;

  function readIfd(offset) {
    if (offset < 0 || offset + 2 > buf.length) return null;
    const count = u16(offset);
    if (count < 1 || count > 512) return null;

    const tags = new Map();

    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      if (entry + 12 > buf.length) break;

      const tag = u16(entry);
      const type = u16(entry + 2);
      const length = u32(entry + 4);

      if (type === 2) {
        // ASCII — inline when <= 4 bytes, otherwise stored at an offset.
        let valueOffset = entry + 8;
        if (length > 4) valueOffset = start + u32(entry + 8);
        const readLength = Math.min(length, 64);
        if (
          valueOffset >= 0 &&
          readLength > 0 &&
          valueOffset + readLength <= buf.length
        ) {
          tags.set(
            tag,
            buf
              .toString("ascii", valueOffset, valueOffset + readLength)
              .replace(/\0.*$/, "")
              .trim()
          );
        }
      } else if (type === 4 && length === 1) {
        // LONG — used by the Exif IFD pointer.
        tags.set(tag, u32(entry + 8));
      }
    }

    return tags;
  }

  const base = readIfd(ifd0);
  if (!base) return null;

  const exifPointer = base.get(0x8769);
  const exif = exifPointer ? readIfd(start + exifPointer) : null;

  const raw =
    (exif && (exif.get(0x9003) || exif.get(0x9004))) ||
    base.get(0x0132);

  return exifDateToIso(raw);
}

function jpegDate(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;

    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) break;

    if (
      marker === 0xe1 &&
      offset + 12 <= buf.length &&
      buf.toString("ascii", offset + 4, offset + 10) === "Exif\0\0"
    ) {
      return tiffDate(buf, offset + 10);
    }

    offset += 2 + length;
  }

  return null;
}

function pngDate(buf) {
  if (
    buf.length < 16 ||
    buf[0] !== 0x89 ||
    buf.toString("ascii", 1, 4) !== "PNG"
  ) {
    return null;
  }

  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);

    if (type === "eXIf") return tiffDate(buf, offset + 8);
    if (type === "IDAT" || type === "IEND") break;

    offset += 12 + length;
  }

  return null;
}

function webpDate(buf) {
  if (
    buf.length < 16 ||
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const type = buf.toString("ascii", offset, offset + 4);
    const length = buf.readUInt32LE(offset + 4);

    if (type === "EXIF") {
      let start = offset + 8;
      if (
        start + 6 <= buf.length &&
        buf.toString("ascii", start, start + 6) === "Exif\0\0"
      ) {
        start += 6;
      }
      return tiffDate(buf, start);
    }

    offset += 8 + length + (length % 2);
  }

  return null;
}

function mp4Date(buf) {
  // `moov` may sit at the start or the end of the file, so callers pass
  // whichever slice contains it. Scanning for `mvhd` avoids parsing every box.
  let index = buf.indexOf("mvhd");

  while (index !== -1) {
    const base = index + 4; // skip "mvhd"

    if (base + 4 <= buf.length) {
      const version = buf[base];
      let seconds = 0;

      if (version === 1 && base + 12 <= buf.length) {
        seconds =
          buf.readUInt32BE(base + 4) * 4294967296 +
          buf.readUInt32BE(base + 8);
      } else if (version === 0 && base + 8 <= buf.length) {
        seconds = buf.readUInt32BE(base + 4);
      }

      // QuickTime time is seconds since 1904-01-01 UTC.
      if (seconds > 2082844800) {
        const ms = (seconds - 2082844800) * 1000;
        const date = new Date(ms);
        const year = date.getUTCFullYear();

        if (
          !Number.isNaN(date.getTime()) &&
          year >= 1970 &&
          year <= 2100 &&
          date.getTime() <= Date.now() + 86400000
        ) {
          return date.toISOString();
        }
      }
    }

    index = buf.indexOf("mvhd", index + 4);
  }

  return null;
}

function extractMediaDate(buf, fileName) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;

  const name = String(fileName || "").toLowerCase();

  if (/\.(jpe?g)$/.test(name)) return jpegDate(buf);
  if (/\.png$/.test(name)) return pngDate(buf);
  if (/\.webp$/.test(name)) return webpDate(buf);
  if (/\.(mp4|mov|m4v)$/.test(name)) return mp4Date(buf);

  return null;
}

module.exports = { extractMediaDate, exifDateToIso };
