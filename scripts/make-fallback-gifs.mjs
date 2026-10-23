import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 120;
const H = 75;
const PALETTE = [[10, 10, 18], [143, 69, 255], [242, 239, 255], [58, 43, 102]];
const BG = 0, INK = 1, BRIGHT = 2, DIM = 3;
const FRAMES = 10;
const DELAY_GCE = 12;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function frame() { return new Uint8Array(W * H); }
function setPx(f, x, y, c) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  f[y * W + x] = c;
}
function disc(f, cx, cy, r, c) {
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) setPx(f, x, y, c);
    }
  }
}
function ring(f, cx, cy, r, thickness, c) {
  const inner = r - thickness;
  for (let y = Math.floor(cy - r - 2); y <= Math.ceil(cy + r + 2); y++) {
    for (let x = Math.floor(cx - r - 2); x <= Math.ceil(cx + r + 2); x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d <= r && d >= inner) setPx(f, x, y, c);
    }
  }
}
function thickLine(f, x0, y0, x1, y1, c, w = 3) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    disc(f, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, c);
  }
}
function fillRect(f, x, y, w, h, c) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) setPx(f, i, j, c);
}

const REACTIONS = {
  clap() {
    return t => {
      const f = frame();
      const e = t < 0.85 ? t / 0.85 : 1;
      const gap = 30 - 26 * e;
      const cx = 60;
      disc(f, cx - gap / 2 - 5, 40, 9, INK);
      disc(f, cx + gap / 2 + 5, 40, 9, INK);
      if (t >= 0.85) {
        disc(f, cx, 40, 5, BRIGHT);
        ring(f, cx, 40, 8 + (t - 0.85) * 40, 1.6, BRIGHT);
      }
      return f;
    };
  },
  lol() {
    return t => {
      const f = frame();
      for (let k = 0; k < 3; k++) {
        const ph = (t * 2 + k * 0.33) % 1;
        const hop = 1 - Math.abs(2 * ph - 1);
        disc(f, 28 + k * 32, 52 - 34 * hop, 6, k === 1 ? BRIGHT : INK);
      }
      return f;
    };
  },
  wow() {
    return t => {
      const f = frame();
      disc(f, 60, 37, 4 + 9 * t, BRIGHT);
      if (t > 0.3) ring(f, 60, 37, 8 + 30 * (t - 0.3) / 0.7, 1.6, INK);
      return f;
    };
  },
  yes() {
    return t => {
      const f = frame();
      const segs = [[20, 40], [46, 62], [46, 62], [96, 12]];
      const total = t < 0.45 ? t / 0.45 : 1;
      const p = total * 0.6;
      if (p >= 0) thickLine(f, 20, 40, 20 + (46 - 20) * Math.min(1, p / 0.6), 40 + (62 - 40) * Math.min(1, p / 0.6), INK, 5);
      if (p > 0.6) { const q = (p - 0.6) / 0.4; thickLine(f, 46, 62, 46 + (96 - 46) * q, 62 + (12 - 62) * q, INK, 5); }
      if (t > 0.92) disc(f, 96, 12, 3, BRIGHT);
      return f;
    };
  },
  nope() {
    return t => {
      const f = frame();
      const p1 = Math.min(1, t / 0.5);
      thickLine(f, 22, 14, 22 + 76 * p1, 14 + 52 * p1, INK, 4);
      if (t > 0.5) { const p2 = Math.min(1, (t - 0.5) / 0.4); thickLine(f, 98, 14, 98 - 76 * p2, 14 + 52 * p2, INK, 4); }
      if (t > 0.9) { fillRect(f, 22, 14, 76, 52, BG); thickLine(f, 98, 14, 22, 66, BRIGHT, 4); thickLine(f, 22, 14, 98, 66, BRIGHT, 4); }
      return f;
    };
  },
  love() {
    return t => {
      const f = frame();
      const s = 1 + 0.14 * Math.sin(t * Math.PI * 2);
      const sx = 28 * s, sy = 23 * s;
      disc(f, 47, 28, 11 * s, INK);
      disc(f, 73, 28, 11 * s, INK);
      for (let y = 18; y < 62; y++) {
        for (let x = 36; x < 84; x++) {
          const nx = (x - 60) / sx;
          const ny = (38 - y) / sy;
          const v = (nx * nx + ny * ny - 1) ** 3 - nx * nx * ny * ny * ny;
          if (v < 0) setPx(f, x, y, v < -0.9 ? INK : BRIGHT);
        }
      }
      return f;
    };
  },
  facepalm() {
    return t => {
      const f = frame();
      const shake = t > 0.75 ? (Math.sin(t * 40) > 0 ? 2 : -2) : 0;
      disc(f, 74 + shake, 38, 15, DIM);
      disc(f, 69 + shake, 33, 4, BRIGHT);
      const px = 26 + 38 * Math.min(1, t / 0.7);
      const py = 14 + 20 * Math.min(1, t / 0.7);
      disc(f, px, py, 6, INK);
      fillRect(f, Math.round(px) - 3, Math.round(py) - 9, 6, 18, INK);
      return f;
    };
  },
  shock() {
    return t => {
      const f = frame();
      const r = 4 + 34 * t;
      ring(f, 60, 37, r, 1.6, INK);
      disc(f, 60, 37, 3, BRIGHT);
      ring(f, 60, 37, 10 + 34 * ((t + 0.5) % 1), 1, DIM);
      return f;
    };
  },
  applause() {
    return t => {
      const f = frame();
      const cyc = Math.abs(Math.sin(t * Math.PI * 3));
      const gap = 12 + 20 * cyc;
      disc(f, 60 - gap / 2 - 6, 40, 8, INK);
      disc(f, 60 + gap / 2 + 6, 40, 8, INK);
      if (cyc < 0.18) { ring(f, 60, 32 - cyc * 40, 4 + (1 - cyc) * 12, 1.2, BRIGHT); }
      return f;
    };
  },
};

function le16(v) { return [v & 0xff, (v >> 8) & 0xff]; }

function lzwEncode(pix) {
  const bytes = [];
  let bitBuf = 0, bitCnt = 0;
  const write = (code, len) => {
    bitBuf |= code << bitCnt;
    bitCnt += len;
    while (bitCnt >= 8) { bytes.push(bitBuf & 0xff); bitBuf >>>= 8; bitCnt -= 8; }
  };
  const flush = () => { if (bitCnt > 0) { bytes.push(bitBuf & 0xff); bitBuf = 0; bitCnt = 0; } };
  const CLEAR = 4, EOI = 5;
  write(CLEAR, 3);
  for (let i = 0; i < pix.length; i += 2) {
    write(CLEAR, 3);
    write(pix[i], 3);
    if (i + 1 < pix.length) write(pix[i + 1], 3);
  }
  write(EOI, 3);
  flush();
  return Uint8Array.from(bytes);
}

function decodeLiterals(data, expectedLen) {
  const out = [];
  let bitPos = 0;
  const read = () => {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const byte = data[(bitPos >> 3) | 0];
      if (byte === undefined) return null;
      v |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return v;
  };
  while (out.length < expectedLen) {
    const code = read();
    if (code === null) return null;
    if (code === 4) continue;
    if (code === 5) break;
    if (code < 4) out.push(code);
    else return null;
  }
  return out;
}

function makeGif(frames) {
  const out = [];
  const pushByte = b => out.push(b & 0xff);
  const pushWord = v => { out.push(v & 0xff, (v >> 8) & 0xff); };
  const str = s => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };

  str('GIF89a');
  pushWord(W); pushWord(H);
  out.push(0xF1, 0, 0);
  for (const [r, g, b] of PALETTE) { out.push(r, g, b); }
  out.push(0x21, 0xFF, 0x0B);
  str('NETSCAPE2.0');
  out.push(0x03, 0x01); pushWord(0); out.push(0x00);

  for (const f of frames) {
    out.push(0x21, 0xF9, 0x04, 0x04);
    pushWord(DELAY_GCE);
    out.push(0x00, 0x00);
    out.push(0x2C); pushWord(0); pushWord(0); pushWord(W); pushWord(H); out.push(0x00);
    out.push(2);
    const lzw = lzwEncode(f);
    for (let i = 0; i < lzw.length; i += 255) {
      const n = Math.min(255, lzw.length - i);
      out.push(n);
      for (let j = 0; j < n; j++) out.push(lzw[i + j]);
    }
    out.push(0x00);
  }
  out.push(0x3B);
  return Buffer.from(out);
}

function roundtripValidate(gifBytes, sourceFrames) {
  const prefixLen =
    6 + 7 + PALETTE.length * 3 + 19;
  let p = prefixLen;
  const frames = [];
  while (gifBytes[p] !== 0x3B && p < gifBytes.length) {
    if (gifBytes[p] === 0x21) {
      p += 2;
      while (gifBytes[p] !== 0) p += gifBytes[p] + 1;
      p++;
      continue;
    }
    if (gifBytes[p] === 0x2C) {
      p += 10;
      const minCodeSize = gifBytes[p++];
      const data = [];
      let block = gifBytes[p++];
      while (block !== 0) { for (let i = 0; i < block; i++) data.push(gifBytes[p++]); block = gifBytes[p++]; }
      const decoded = decodeLiterals(data, W * H);
      if (!decoded) return { ok: false, why: 'decode failed' };
      if (decoded.length !== W * H) return { ok: false, why: 'length mismatch' };
      frames.push(decoded);
      continue;
    }
    return { ok: false, why: 'unexpected byte ' + gifBytes[p] };
  }
  if (frames.length !== sourceFrames.length) return { ok: false, why: 'frame count mismatch' };
  for (let i = 0; i < frames.length; i++) {
    for (let k = 0; k < W * H; k++) {
      if (frames[i][k] !== sourceFrames[i][k]) {
        return { ok: false, why: `pixel mismatch frame ${i} px ${k}` };
      }
    }
  }
  const pal3 = new Set();
  for (const fr of frames) for (const v of fr) pal3.add(v);
  if (pal3.size < 3) return { ok: false, why: 'gif looks static/degenerate' };
  return { ok: true, why: 'roundtrip ok' };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', 'public', 'fallback');
fs.mkdirSync(OUT_DIR, { recursive: true });

let failures = 0;
for (const [name, make] of Object.entries(REACTIONS)) {
  const frames = [];
  for (let i = 0; i < FRAMES; i++) frames.push(make()(i / (FRAMES - 1)));
  const gif = makeGif(frames);
  const check = roundtripValidate(gif, frames);
  if (!check.ok) {
    console.error(`FAIL ${name}: ${check.why}`);
    fs.writeFileSync(path.join(OUT_DIR, '__debug-' + name + '.gif'), gif);
    failures++;
    continue;
  }
  const file = path.join(OUT_DIR, name + '.gif');
  fs.writeFileSync(file, gif);
  console.log(`ok ${name.padEnd(9)} ${(gif.length / 1024).toFixed(1)} KB  ${FRAMES} frames`);
}

if (failures) { console.error(`${failures} gif(s) failed validation`); process.exit(1); }
console.log('fallback GIF set generated in public/fallback');
