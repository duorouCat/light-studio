/* =====================================================================
 *  bevel.js 自测（Node 直接运行，不依赖浏览器）
 *    node tools/bevel-test.mjs
 *
 *  检查项：
 *    1. 水密性：每条边恰好被 2 个三角形共享，且方向相反（无开边 / 无重复边）
 *    2. 无 NaN / 无退化三角形 / 法线为单位向量
 *    3. 体积守恒：倒角只削掉一点点材料（损失 0.2%~8%）
 *    4. 平滑模型（球体 seg32）返回 null，不破坏原有平滑外观
 *    5. 倒角后确实多出窄面（法线数量增加）
 *    6. 单次耗时（用于评估滑杆拖动的流畅度）
 * ===================================================================== */
import * as THREE from '../vendor/three.module.js';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

/* Node 无法解析裸标识符 'three'，临时替换为相对路径后导入（逻辑完全一致） */
const tmp = new URL('./_bevel-tmp.mjs', import.meta.url);
writeFileSync(
  tmp,
  readFileSync(new URL('../bevel.js', import.meta.url), 'utf8').replace("from 'three'", "from '../vendor/three.module.js'"),
);
const { bevelGeometry } = await import(tmp);
rmSync(tmp, { force: true });

/* 与 app.js 中 MODEL_DEFS 一致的模型构造 */
const cases = [
  ['立方体', () => new THREE.BoxGeometry(1.4, 1.4, 1.4), 0.05],
  ['球体 seg8', () => new THREE.SphereGeometry(0.85, 8, 8), 0.03],
  ['球体 seg16', () => new THREE.SphereGeometry(0.85, 16, 8), 0.03],
  ['球体 seg32', () => new THREE.SphereGeometry(0.85, 32, 16), 0.03],
  ['圆柱 seg8', () => new THREE.CylinderGeometry(0.75, 0.75, 1.5, 8, 1, false), 0.04],
  ['圆柱 seg16', () => new THREE.CylinderGeometry(0.75, 0.75, 1.5, 16, 1, false), 0.04],
  ['圆柱 seg32', () => new THREE.CylinderGeometry(0.75, 0.75, 1.5, 32, 1, false), 0.04],
  ['圆柱 顶径比0 seg16', () => new THREE.CylinderGeometry(0, 0.75, 1.5, 16, 1, false), 0.04],
  ['圆锥 seg16', () => new THREE.ConeGeometry(0.9, 1.6, 16, 1, false), 0.04],
  ['圆锥 seg32', () => new THREE.ConeGeometry(0.9, 1.6, 32, 1, false), 0.04],
  ['四面体 d0', () => new THREE.TetrahedronGeometry(0.95, 0), 0.05],
  ['四面体 d1', () => new THREE.TetrahedronGeometry(0.95, 1), 0.03],
  ['八面体 d0', () => new THREE.OctahedronGeometry(0.95, 0), 0.05],
  ['八面体 d1', () => new THREE.OctahedronGeometry(0.95, 1), 0.03],
  ['二十面体 d0', () => new THREE.IcosahedronGeometry(0.95, 0), 0.05],
  ['二十面体 d1', () => new THREE.IcosahedronGeometry(0.95, 1), 0.03],
  ['二十面体 d2', () => new THREE.IcosahedronGeometry(0.95, 2), 0.02],
  ['十二面体 d0', () => new THREE.DodecahedronGeometry(0.95, 0), 0.05],
  ['十二面体 d1', () => new THREE.DodecahedronGeometry(0.95, 1), 0.03],
  ['圆环结 seg16', () => new THREE.TorusKnotGeometry(0.52, 0.17, 16, 8), 0.03],
  ['圆环结 seg32', () => new THREE.TorusKnotGeometry(0.52, 0.17, 32, 8), 0.03],
  ['圆环结 seg64', () => new THREE.TorusKnotGeometry(0.52, 0.17, 64, 8), 0.02],
];

const q = (v) => Math.round(v * 1e5);

/** 取出焊接后的三角形顶点坐标（兼容索引 / 非索引） */
function triangles(geo) {
  const pos = geo.attributes.position;
  const index = geo.index;
  const count = (index ? index.count : pos.count) / 3;
  const out = [];
  for (let t = 0; t < count; t++) {
    const p = [];
    for (let k = 0; k < 3; k++) {
      const i = index ? index.getX(t * 3 + k) : t * 3 + k;
      p.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
    }
    out.push(p);
  }
  return out;
}

/** 源网格的最大二面角（度）——决定“是否应该有硬棱可倒角” */
function maxDihedral(geo) {
  const tris = triangles(geo);
  const map = new Map();
  tris.forEach((p, ti) => {
    const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
    if (n.lengthSq() < 1e-20) return;
    n.normalize();
    const keys = p.map((v) => q(v.x) + ',' + q(v.y) + ',' + q(v.z));
    for (let k = 0; k < 3; k++) {
      const a = keys[k], b = keys[(k + 1) % 3];
      const key = a < b ? a + '_' + b : b + '_' + a;
      const rec = map.get(key) || { n, count: 0 };
      rec.count++;
      if (rec.count === 2) rec.n2 = n;
      map.set(key, rec);
    }
  });
  let max = 0;
  for (const rec of map.values()) {
    if (rec.count !== 2 || !rec.n2) continue;
    const ang = (Math.acos(Math.min(1, Math.max(-1, rec.n.dot(rec.n2)))) * 180) / Math.PI;
    if (ang > max) max = ang;
  }
  return max;
}

/** 网格体检：开边 / 重复边 / NaN / 退化 / 体积 / 法线数量 */
function inspect(geo) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const tris = triangles(geo);
  const edges = new Map();
  let nan = 0, degen = 0, badNormal = 0;
  let volume = 0;
  const normalSet = new Set();
  for (const [a, b, c] of tris) {
    for (const v of [a, b, c]) if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) nan++;
    const cross = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (cross.lengthSq() < 1e-18) degen++;
    volume += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
    const keys = [a, b, c].map((v) => q(v.x) + ',' + q(v.y) + ',' + q(v.z));
    for (let k = 0; k < 3; k++) {
      const p = keys[k], r = keys[(k + 1) % 3];
      const key = p < r ? p + '_' + r : r + '_' + p;
      const rec = edges.get(key) || { n: 0, dir: 0 };
      rec.n++;
      rec.dir += p < r ? 1 : -1;
      edges.set(key, rec);
    }
  }
  if (nrm) {
    for (let i = 0; i < nrm.count; i++) {
      const n = new THREE.Vector3().fromBufferAttribute(nrm, i);
      if (Math.abs(n.length() - 1) > 1e-3) badNormal++;
      normalSet.add(q(n.x) + ',' + q(n.y) + ',' + q(n.z));
    }
  }
  let open = 0, dup = 0;
  for (const rec of edges.values()) {
    if (rec.n === 1) open++;
    else if (rec.n !== 2 || rec.dir !== 0) dup++;
  }
  return { tris: tris.length, open, dup, nan, degen, badNormal, volume: Math.abs(volume), normals: normalSet.size };
}

let fail = 0;
for (const [name, build, w] of cases) {
  const src = build();
  const before = inspect(src);
  const ang = maxDihedral(src);
  const shouldBevel = ang > 30;                 // 留出与算法 25° 阈值的安全余量
  const dbg = {};
  const t0 = process.hrtime.bigint();
  let out = null;
  let err = null;
  try {
    out = bevelGeometry(src, w, dbg);
  } catch (e) {
    err = e;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (err) {
    fail++;
    console.error(`FAIL ${name}: 抛异常 ${err.message}\n${err.stack}`);
    src.dispose();
    continue;
  }
  const tag = `最大二面角 ${ang.toFixed(1)}°`;
  if (!out) {
    if (shouldBevel) {
      fail++;
      console.error(`FAIL ${name}: ${tag} 但返回 null（应有可倒角硬棱）`);
    } else {
      console.log(`OK   ${name}: ${tag} → 无可倒角硬棱（保持原几何）`);
    }
    src.dispose();
    continue;
  }
  const r = inspect(out);
  const loss = (before.volume - r.volume) / before.volume;
  const problems = [];
  if (r.open) problems.push(`开边 ${r.open}`);
  if (r.dup) problems.push(`重复/反向边 ${r.dup}`);
  if (r.nan) problems.push(`NaN ${r.nan}`);
  if (r.degen) problems.push(`退化面 ${r.degen}`);
  if (r.badNormal) problems.push(`法线非单位 ${r.badNormal}`);
  if (r.volume > before.volume * 1.001) problems.push(`体积反而变大 ${r.volume.toFixed(4)} > ${before.volume.toFixed(4)}`);
  if (loss > 0.08) problems.push(`体积损失过大 ${(loss * 100).toFixed(2)}%`);
  if (r.normals <= before.normals) problems.push('法线数量未增加（没有生成新窄面）');
  if (!shouldBevel) problems.push(`源模型最大二面角仅 ${ang.toFixed(1)}°，本不该倒角`);
  const info = `${before.tris} → ${r.tris} 三角，法线 ${before.normals} → ${r.normals}，体积损失 ${(loss * 100).toFixed(2)}%，${ms.toFixed(1)}ms，cap=${dbg.caps || 0}/skip=${dbg.capSkip || 0}`;
  if (problems.length) {
    fail++;
    console.error(`FAIL ${name}: ${tag} | ${info} | ${problems.join('，')}`);
  } else {
    console.log(`OK   ${name}: ${tag} | ${info}`);
  }
  out.dispose();
  src.dispose();
}

/* 极端宽度：应被限制到安全倒角量或安全放弃，不得生成烂几何 */
{
  const g = new THREE.BoxGeometry(1.4, 1.4, 1.4);
  const big = bevelGeometry(g, 10);
  const r = big ? inspect(big) : null;
  if (big && (r.open || r.dup || r.degen || r.nan)) {
    fail++;
    console.error(`FAIL 超大宽度：生成非法几何（开边 ${r.open}，重复边 ${r.dup}，退化 ${r.degen}）`);
  } else {
    console.log(`OK   超大宽度：${big ? '被限制到安全倒角量' : '安全放弃（返回 null）'}`);
  }
  g.dispose();
  if (big) big.dispose();
}

console.log(fail ? `\n${fail} 个用例失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
