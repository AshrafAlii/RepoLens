"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractMediaDate, exifDateToIso } = require("../lib/media-date");

// Builds a minimal little-endian TIFF block with IFD0 + Exif IFD.
// DateTime (0x0132) is deliberately different from DateTimeOriginal (0x9003)
// so the test proves which tag wins.
function makeTiff() {
  const tiff = Buffer.alloc(96);

  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 offset

  // IFD0: two entries.
  tiff.writeUInt16LE(2, 8);

  // Entry 0: Exif IFD pointer (LONG -> offset 38).
  tiff.writeUInt16LE(0x8769, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(38, 18);

  // Entry 1: DateTime (ASCII 20 bytes -> offset 56).
  tiff.writeUInt16LE(0x0132, 22);
  tiff.writeUInt16LE(2, 24);
  tiff.writeUInt32LE(20, 26);
  tiff.writeUInt32LE(56, 30);

  // No next IFD.
  tiff.writeUInt32LE(0, 34);

  // Exif IFD at 38: one entry, DateTimeOriginal (ASCII 20 -> offset 76).
  tiff.writeUInt16LE(1, 38);
  tiff.writeUInt16LE(0x9003, 40);
  tiff.writeUInt16LE(2, 42);
  tiff.writeUInt32LE(20, 44);
  tiff.writeUInt32LE(76, 48);
  tiff.writeUInt32LE(0, 52);

  tiff.write("2020:01:01 00:00:00\0", 56, "ascii");
  tiff.write("2025:12:29 09:25:04\0", 76, "ascii");

  return tiff;
}

test("exifDateToIso converts EXIF timestamps to UTC ISO", () => {
  assert.equal(exifDateToIso("2025:12:29 09:25:04"), "2025-12-29T09:25:04.000Z");
  assert.equal(exifDateToIso("not a date"), null);
  assert.equal(exifDateToIso("0000:00:00 00:00:00"), null);
});

test("reads DateTimeOriginal from a JPEG APP1 segment", () => {
  const tiff = makeTiff();
  const app1 = Buffer.alloc(10 + tiff.length);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(8 + tiff.length, 2);
  app1.write("Exif\0\0", 4, "binary");
  tiff.copy(app1, 10);

  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    Buffer.from([0xff, 0xd9]),
  ]);

  assert.equal(
    extractMediaDate(jpeg, "IMG_7853.jpeg"),
    "2025-12-29T09:25:04.000Z"
  );
});

test("reads an eXIf chunk from a PNG", () => {
  const tiff = makeTiff();
  const chunk = Buffer.alloc(12 + tiff.length);
  chunk.writeUInt32BE(tiff.length, 0);
  chunk.write("eXIf", 4, "ascii");
  tiff.copy(chunk, 8);

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk,
  ]);

  assert.equal(
    extractMediaDate(png, "photo.png"),
    "2025-12-29T09:25:04.000Z"
  );
});

test("reads the mvhd creation time from an MP4/MOV header", () => {
  const seconds = 1700000000 + 2082844800; // QuickTime epoch
  const mp4 = Buffer.alloc(64);
  mp4.write("mvhd", 4, "ascii");
  mp4[8] = 0; // version 0
  mp4.writeUInt32BE(seconds, 12);

  assert.equal(
    extractMediaDate(mp4, "IMG_2469.mov"),
    new Date(1700000000 * 1000).toISOString()
  );
});

test("returns null when a file has no embedded date", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44]),
  ]);

  assert.equal(extractMediaDate(png, "screenshot.png"), null);
  assert.equal(extractMediaDate(Buffer.from("plain text"), "notes.txt"), null);
  assert.equal(extractMediaDate(Buffer.alloc(0), "empty.jpeg"), null);
});
