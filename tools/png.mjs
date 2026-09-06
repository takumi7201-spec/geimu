/**
 * 最小限の PNG エンコーダ（RGBA 8bit、フィルタ 0）。
 * CLI のレンダラ・アイコン生成・区画の書き出しで共用する。
 */

import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

export function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- デコーダ ---------------------------------------------------------
// ドット絵はパレット PNG で書き出されることが多いので colorType 0/2/3/6 を通す。
// bitDepth は 8 のみ（8 未満のドット絵に当たったら、その旨を投げて気づけるようにする）。

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** PNG を { w, h, data:RGBA } に開く */
export function decodePNG(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('PNG ではありません');

  let w = 0, h = 0, depth = 8, colorType = 6;
  let palette = null, trns = null;
  const idat = [];

  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      depth = body[8]; colorType = body[9];
      if (body[12] !== 0) throw new Error('インタレース PNG には未対応です');
    } else if (type === 'PLTE') palette = Buffer.from(body);
    else if (type === 'tRNS') trns = Buffer.from(body);
    else if (type === 'IDAT') idat.push(Buffer.from(body));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8) throw new Error(`bitDepth ${depth} には未対応です（8 で書き出してください）`);

  const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!CH) throw new Error(`colorType ${colorType} には未対応です`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * CH;
  const lines = Buffer.alloc(h * stride);

  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = lines.subarray(y * stride, (y + 1) * stride);
    const prev = y ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= CH ? cur[i - CH] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= CH ? prev[i - CH] : 0;
      const x = src[i];
      cur[i] = (ft === 0 ? x : ft === 1 ? x + a : ft === 2 ? x + b
        : ft === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 0xff;
    }
  }

  const data = new Uint8Array(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const s = i * CH, d = i * 4;
    if (colorType === 6) { data[d] = lines[s]; data[d+1] = lines[s+1]; data[d+2] = lines[s+2]; data[d+3] = lines[s+3]; }
    else if (colorType === 2) { data[d] = lines[s]; data[d+1] = lines[s+1]; data[d+2] = lines[s+2]; data[d+3] = 255; }
    else if (colorType === 0) { data[d] = data[d+1] = data[d+2] = lines[s]; data[d+3] = 255; }
    else if (colorType === 4) { data[d] = data[d+1] = data[d+2] = lines[s]; data[d+3] = lines[s+1]; }
    else {
      const k = lines[s];
      data[d] = palette[k*3]; data[d+1] = palette[k*3+1]; data[d+2] = palette[k*3+2];
      data[d+3] = trns && k < trns.length ? trns[k] : 255;
    }
  }
  return { w, h, data };
}
