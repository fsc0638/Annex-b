// png.mjs — minimal dependency-free PNG encoder (RGBA, 8-bit, no interlace).
//
// Used by the asset generator scripts (gen_office_shell.mjs,
// gen_agent_sprites.mjs) to emit self-made CC0 placeholder art without
// pulling any npm dependency (project constraint: node 20 stdlib only).
//
// Output is deterministic for a given input buffer: zlib.deflateSync with a
// fixed level and fixed chunk layout, so re-running a generator on the same
// machine yields byte-identical files (idempotency is an acceptance
// criterion for the generators).

import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Standard CRC-32 (IEEE 802.3), table-driven.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Encodes an RGBA pixel buffer as a PNG file buffer.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba - length must be width*height*4
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `encodePng: rgba length ${rgba.length} != ${width}x${height}x4`
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw scanlines, each prefixed with filter byte 0 (None).
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    const srcStart = y * width * 4;
    rgba
      .subarray(srcStart, srcStart + width * 4)
      .forEach((v, i) => (raw[rowStart + 1 + i] = v));
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Small helper: a mutable RGBA canvas with pixel/rect painting, for drawing
 * the placeholder tiles and sprites.
 */
export class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4); // transparent black
  }

  /** color = [r,g,b,a?] (a defaults to 255) */
  set(x, y, color) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = color[0];
    this.data[i + 1] = color[1];
    this.data[i + 2] = color[2];
    this.data[i + 3] = color.length > 3 ? color[3] : 255;
  }

  fillRect(x, y, w, h, color) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        this.set(xx, yy, color);
      }
    }
  }

  toPng() {
    return encodePng(this.width, this.height, this.data);
  }
}
