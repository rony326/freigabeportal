import { deflateSync, crc32 } from 'node:zlib';

// Smallest-possible valid 1x1 pixel images, used wherever a test needs bytes that pdf-lib's
// embedPng/embedJpg (and a byte-signature sniff) will genuinely accept — unlike a bare magic-byte
// header, these parse as real, complete images.
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
}

// Builds a genuine, valid solid-color PNG of arbitrary width/height — used by tests that need an
// image with a specific (non-1x1) aspect ratio, e.g. to exercise A4 portrait/landscape fitting.
export function buildSolidPng(width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  const rowBytes = width * 3 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowBytes] = 0; // filter type: none
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdrData),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
  'base64'
);
