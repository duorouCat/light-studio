/* =====================================================================
 *  tools/render-check.mjs · 渲染数值自检（开发用）
 *
 *  思路：无头 Chrome 只能把画面写成 PNG，且无法交互；于是
 *    1) 用 tools/seed.html 把目标参数写进 localStorage 再跳转主页面；
 *    2) 用 --screenshot 截图（务必走 GPU：软件渲染每张图要 1~2 分钟）；
 *    3) 用 tools/png-stats.mjs 解码 PNG，做「通道差分 / 色相统计 / 错误条检测」；
 *    4) 断言「参数变化 → 画面变化」是否成立。
 *
 *  注意：差分必须按 RGB 通道比，不能只看亮度——橙(#e6b56a)与绿(#00ff00)亮度几乎相同，
 *        只比亮度会得出「完全没变」的错误结论。
 *
 *  前置：静态服务器在 127.0.0.1:8399（PORT=8399 OPEN_BROWSER=0 node serve.js）
 *  运行：node tools/render-check.mjs
 * ===================================================================== */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng } from './png-stats.mjs';

const BASE = process.env.CHECK_BASE || 'http://127.0.0.1:8399';
const CHROME =
  process.env.CHROME_PATH ||
  [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => existsSync(p));
const SHOT_DIR = join(tmpdir(), 'light-studio-shots');
const PROFILE_ROOT = join(tmpdir(), 'light-studio-profiles');

/* 窗口 1400×900（必须 > 1100px，否则触发响应式单列布局，采样区就落不到 3D 视口上）
   布局：288px 模型面板 | 视口 | 324px 光照面板，顶栏 56px */
const VP = { x: 296, y: 64, w: 770, h: 700 };

const DEFAULT_DEFS = [
  { type: 'directional', kelvin: 6500, intensity: 2.5, azimuth: 0, elevation: 45, distance: 7, custom: false, customColor: '#ffffff', shadow: true, enabled: true, angle: 30, penumbra: 0.5 },
];

function stateOf(id, model, over = {}) {
  return {
    lightCount: 1,
    defs: DEFAULT_DEFS,
    ambientI: 0.5,
    ambientK: 6500,
    hemiOn: false,
    hemiI: 0.4,
    exposure: 1,
    envI: 0.55,
    bg: 'studio',
    selectedId: id,
    shownIds: [id],
    faceSnapMode: false,
    addMode: true,
    modelState: {
      [id]: { bevel: 0.03, metalness: 0.25, roughness: 0.45, color: '#e6b56a', sx: 1, sy: 1, sz: 1, rx: 0, ry: 0, rz: 0, seg: 32, detail: 0, topRatio: 1, wire: false, edges: false, spin: 0, ...model },
    },
    autorotate: false,
    showMarkers: true,
    showGrid: true,
    ...over,
  };
}

async function shot(name, state) {
  const b64 = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
  const url = `${BASE}/tools/seed.html?s=${encodeURIComponent(b64)}`;
  const file = join(SHOT_DIR, name + '.png');
  rmSync(file, { force: true });
  const profile = join(PROFILE_ROOT, name);
  rmSync(profile, { recursive: true, force: true });
  const args = [
    '--headless=new',
    '--no-sandbox',
    /* 不要加 --disable-gpu：软件渲染每张图 1~2 分钟，走 GPU 只要 1~2 秒 */
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-background-networking',
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1400,900',
    '--virtual-time-budget=1200',
    `--screenshot=${file}`,
    url,
  ];
  const t0 = Date.now();
  await new Promise((resolve) => {
    const child = spawn(CHROME, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
    child.on('error', () => { clearTimeout(timer); resolve(); });
  });
  if (!existsSync(file)) throw new Error('截图失败：' + name);
  process.stdout.write(`[${name} ${((Date.now() - t0) / 1000).toFixed(1)}s] `);
  return decodePng(readFileSync(file));
}

/** 通道差分：任一通道差值 > tol 视为变化 */
function diff(a, b, region = VP, tol = 12) {
  const { width } = a;
  let changed = 0, total = 0;
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      const i = (y * width + x) * 4;
      total++;
      if (
        Math.abs(a.rgba[i] - b.rgba[i]) > tol ||
        Math.abs(a.rgba[i + 1] - b.rgba[i + 1]) > tol ||
        Math.abs(a.rgba[i + 2] - b.rgba[i + 2]) > tol
      ) changed++;
    }
  }
  return { changed, pct: +((changed / total) * 100).toFixed(2) };
}

/** 统计明显偏绿的像素数（用于验证颜色参数确实生效） */
function greenPixels(img, region = VP) {
  const { width } = img;
  let n = 0;
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      const i = (y * width + x) * 4;
      if (img.rgba[i + 1] > img.rgba[i] + 40 && img.rgba[i + 1] > img.rgba[i + 2] + 40) n++;
    }
  }
  return n;
}

/** 顶部错误条检测：#err-bar 背景 rgba(180,40,40,.95) */
function errorBar(img) {
  let red = 0;
  for (let y = 0; y < 34; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const r = img.rgba[i], g = img.rgba[i + 1], b = img.rgba[i + 2];
      if (r > 120 && r - g > 60 && r - b > 60) red++;
    }
  }
  return red;
}

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

mkdirSync(SHOT_DIR, { recursive: true });

/* 放大模型：默认机位下模型只占画面 ~2%，放大后才看得清细节差异 */
const BIG = { sx: 2.2, sy: 2.2, sz: 2.2 };

/* ---------- 0. 应用启动、无报错、渲染出模型 ---------- */
const boot = await shot('boot', stateOf('box', {}));
check('应用启动无错误提示条', errorBar(boot) === 0, `顶部红色像素 ${errorBar(boot)}`);

/* ---------- 1. 颜色参数生效（色相检验） ---------- */
const orange = await shot('box-orange', stateOf('box', { ...BIG, color: '#e6b56a' }));
const green = await shot('box-green', stateOf('box', { ...BIG, color: '#00ff00' }));
console.log('');
check('颜色参数生效（橙色→绿色，绿色像素增加）', greenPixels(green) > greenPixels(orange) + 100, `绿色像素 ${greenPixels(orange)} → ${greenPixels(green)}`);

/* ---------- 2. 锉边：硬棱变窄面 → 画面像素改变 ---------- */
const bevel0 = await shot('box-bevel0', stateOf('box', { ...BIG, bevel: 0 }));
const bevel20 = await shot('box-bevel20', stateOf('box', { ...BIG, bevel: 0.2 }));
const dBevel = diff(bevel0, bevel20);
console.log('');
check('锉边改变几何（0 → 0.2 有明显像素变化）', dBevel.changed > 40, `变化像素 ${dBevel.changed} (${dBevel.pct}%)`);

/* 圆柱端口：侧面平滑，只有上下端口是硬棱，同样应被锉出窄面 */
const cyl0 = await shot('cyl-bevel0', stateOf('cyl', { ...BIG, bevel: 0 }));
const cyl4 = await shot('cyl-bevel4', stateOf('cyl', { ...BIG, bevel: 0.04 }));
const dCyl = diff(cyl0, cyl4);
check('圆柱端口锉边生效', dCyl.changed > 20, `变化像素 ${dCyl.changed} (${dCyl.pct}%)`);

/* ---------- 3. 金属度：非金属 ↔ 金属 ---------- */
const m0 = await shot('sph-metal0', stateOf('sphere', { ...BIG, metalness: 0, roughness: 0.15, bevel: 0 }, { envI: 2 }));
const m1 = await shot('sph-metal1', stateOf('sphere', { ...BIG, metalness: 1, roughness: 0.15, bevel: 0 }, { envI: 2 }));
const dMetal = diff(m0, m1);
console.log('');
check('金属度影响明显（画面变化 > 1%）', dMetal.pct > 1, `变化 ${dMetal.pct}%`);

/* ---------- 4. 粗糙度：镜面 ↔ 磨砂 ---------- */
const r05 = await shot('sph-rough05', stateOf('sphere', { ...BIG, metalness: 1, roughness: 0.05, bevel: 0 }, { envI: 2 }));
const r95 = await shot('sph-rough95', stateOf('sphere', { ...BIG, metalness: 1, roughness: 0.95, bevel: 0 }, { envI: 2 }));
const dRough = diff(r05, r95);
check('粗糙度影响明显（画面变化 > 1%）', dRough.pct > 1, `变化 ${dRough.pct}%`);

/* ---------- 5. 环境反射强度（IBL 是否真的在起作用）：用明亮天空环境，差异更明显 ---------- */
const e0 = await shot('sph-env0', stateOf('sphere', { ...BIG, metalness: 1, roughness: 0.15, bevel: 0 }, { envI: 0, bg: 'day' }));
const e2 = await shot('sph-env2', stateOf('sphere', { ...BIG, metalness: 1, roughness: 0.15, bevel: 0 }, { envI: 2, bg: 'day' }));
const dEnv = diff(e0, e2);
check('环境反射生效（画面变化 > 0.3%）', dEnv.pct > 0.3, `变化 ${dEnv.pct}%`);

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
