/* =====================================================================
 *  tools/png-stats.mjs · 纯 Node 的 PNG 解码 + 画面统计（开发用）
 *
 *  用途：无头 Chrome 的 --screenshot 只能写文件，拿不到 stdout；
 *  这里直接解码 PNG，把「渲染结果」变成可断言的数字。
 *
 *  用法：
 *      node tools/png-stats.mjs shot.png [shot2.png ...]
 *
 *  统计口径（亮度 0–255）：
 *      mean   平均亮度
 *      max    最亮像素（高光峰值）
 *      bright 亮度 > 200 的像素占比（高光面积）
 *      edges  相邻像素亮度跳变 > 24 的像素数（边线密度）
 *      levels 出现过的亮度级数（明暗层次丰富度）
 * ===================================================================== */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

/** 解码 8bit、非隔行的 RGB/RGBA PNG → { width, height, rgba } */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('不是 PNG 文件');
  }
  let off = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (depth !== 8) throw new Error('只支持 8bit 深度，实际 ' + depth);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('只支持 RGB/RGBA，colorType=' + colorType);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error('未知行过滤类型 ' + filter);
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { width, height, rgba: out };
}

/** 画面统计；可传入区域 {x, y, w, h} 只统计局部 */
export function stats(img, region) {
  const { width, height, rgba } = img;
  const x0 = region ? Math.max(0, region.x | 0) : 0;
  const y0 = region ? Math.max(0, region.y | 0) : 0;
  const x1 = region ? Math.min(width, x0 + (region.w | 0)) : width;
  const y1 = region ? Math.min(height, y0 + (region.h | 0)) : height;
  const lum = new Float32Array(width * height);
  const hist = new Uint32Array(256);
  let sum = 0, max = 0, bright = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const l = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
      lum[y * width + x] = l;
      sum += l;
      n++;
      if (l > max) max = l;
      if (l > 200) bright++;
      hist[Math.min(255, Math.round(l))]++;
    }
  }
  let edges = 0;
  for (let y = y0; y < y1 - 1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      const p = y * width + x;
      const g = Math.abs(lum[p] - lum[p + 1]) + Math.abs(lum[p] - lum[p + width]);
      if (g > 24) edges++;
    }
  }
  let levels = 0;
  for (let i = 0; i < 256; i++) if (hist[i] > 0) levels++;
  return {
    mean: +(sum / n).toFixed(1),
    max: +max.toFixed(1),
    bright: +((bright / n) * 100).toFixed(2),
    edges,
    levels,
  };
}

export function statsOfFile(file, region) {
  return stats(decodePng(readFileSync(file)), region);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.log('用法：node tools/png-stats.mjs shot.png [...]');
    process.exit(1);
  }
  for (const f of files) {
    try {
      console.log(f, JSON.stringify(statsOfFile(f)));
    } catch (err) {
      console.log(f, 'ERROR ' + err.message);
    }
  }
}
