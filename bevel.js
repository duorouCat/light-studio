/* =====================================================================
 *  bevel.js · 锉边（把硬棱磨成一条很窄的斜面）
 *
 *  用途：把模型上“硬棱”（相邻面夹角 ≥ 25° 的凸棱）磨掉，代之以一条很窄的
 *  斜面（倒角面），就像用锉刀把边角锉平一样；这样棱上会出现一条独立朝向的
 *  窄面，光照下的高光 / 明暗过渡在窄面上清晰可见。
 *
 *  构造方式（逐面独立、天然水密，不依赖全局绕向搜索）：
 *    1. 顶点焊接 → 共面三角形合并成多边形面；
 *    2. 找出凸硬棱，计算倒角量 cut（受棱到相邻顶点最短距离限制）；
 *    3. 每个面按“边内缩 cut”求角点（相邻两条内缩线求交）；
 *       —— 未倒角的棱两侧共用同一个角点，保证不出现裂缝；
 *    4. 输出三类三角形：
 *       面片（内缩后的原面） + 斜面（每条硬棱一块窄面） + 顶点帽（顶点处补面）。
 *
 *  返回：非索引、带法线的新 BufferGeometry；没有可倒角的硬棱（例如球面、
 *  圆柱侧面这类平滑面）或中途出现退化情况时返回 null，调用方保留原几何。
 * ===================================================================== */
import * as THREE from 'three';

const MIN_ANGLE = 25;     // 相邻面夹角(°)小于此值 → 视为平滑面，不倒角
const COPLANAR = 0.5;     // 共面三角形合并阈值(°)
const MAX_CUT = 0.4;      // 倒角量上限 = 该比例 × 棱到两面其余顶点的最短距离
const SMOOTH = 35;        // 法线平滑阈值(°)：夹角小于此值共享顶点法线
const PARALLEL = 1e-3;    // 相邻边近似平行判定（|sin 夹角|）

const _t = new THREE.Vector3();
const _u = new THREE.Vector3();

const edgeKeyOf = (i, j) => (i < j ? i + '_' + j : j + '_' + i);

/* ------------------------------ 对外入口 ------------------------------ */
export function bevelGeometry(geometry, width, debug) {
  const w = Number(width);
  if (!geometry || !(w > 0)) return null;

  const src = readMesh(geometry);
  if (!src) return null;
  const faces = buildFaces(src);
  if (!faces || faces.length < 4) return null;
  const edges = buildEdges(faces);
  const cuts = computeCuts(edges, faces, src.verts, w);
  if (!cuts.size) return null;                 // 没有硬棱 → 保持原样
  const corners = computeCorners(faces, edges, cuts, src.verts);
  if (!corners) return null;
  shareSeamCorners(edges, faces, cuts, corners);
  const tris = assemble(faces, edges, cuts, corners, src.verts, debug);
  if (!tris.length) return null;
  const out = buildGeometry(tris, src.size);
  if (debug) {
    debug.faces = faces.length;
    debug.edges = edges.size;
    debug.cuts = cuts.size;
    debug.tris = out ? out.attributes.position.count / 3 : 0;
  }
  return out;
}

/* --------------------- 1. 顶点焊接 + 读取三角形 --------------------- */
function readMesh(geometry) {
  const pos = geometry.attributes && geometry.attributes.position;
  if (!pos || pos.count < 9) return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const size = bb ? bb.max.distanceTo(bb.min) : 1;
  if (!Number.isFinite(size) || size <= 0) return null;
  const eps = Math.max(1e-6, size * 1e-5);
  const areaMin = size * size * 1e-9;
  const index = geometry.index;
  const count = index ? index.count : pos.count;
  const ids = new Map();
  const verts = [];
  const tris = [];
  const keyOf = (x, y, z) =>
    Math.round(x / eps) + ',' + Math.round(y / eps) + ',' + Math.round(z / eps);

  for (let t = 0; t < count / 3; t++) {
    const v = [];
    for (let k = 0; k < 3; k++) {
      const i = index ? index.getX(t * 3 + k) : t * 3 + k;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
      const key = keyOf(x, y, z);
      let id = ids.get(key);
      if (id === undefined) {
        id = verts.length;
        ids.set(key, id);
        verts.push(new THREE.Vector3(x, y, z));
      }
      v.push(id);
    }
    if (v[0] === v[1] || v[1] === v[2] || v[2] === v[0]) continue; // 退化三角形
    const n = new THREE.Vector3()
      .subVectors(verts[v[1]], verts[v[0]])
      .cross(_t.subVectors(verts[v[2]], verts[v[0]]));
    if (n.length() * 0.5 < areaMin) continue;
    tris.push({ v, n: n.normalize() });
  }
  if (tris.length < 4) return null;
  return { verts, tris, size, eps };
}

/* ------------------- 2. 共面三角形合并为多边形面 ------------------- */
function makeFace(vids, normal, verts) {
  const center = new THREE.Vector3();
  for (const id of vids) center.add(verts[id]);
  center.multiplyScalar(1 / vids.length);
  return { vids, normal, center };
}

function buildFaces(src) {
  const { tris, verts } = src;
  const ekey = (i, j) => (i < j ? i + '_' + j : j + '_' + i);

  /* 三角形 → 共享边 */
  const edgeTris = new Map();
  tris.forEach((t, ti) => {
    const [a, b, c] = t.v;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = ekey(p, q);
      let arr = edgeTris.get(k);
      if (!arr) edgeTris.set(k, (arr = []));
      arr.push(ti);
    }
  });

  /* 并查集：共面且相邻的三角形合并 */
  const parent = tris.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const cosCop = Math.cos((COPLANAR * Math.PI) / 180);
  for (const arr of edgeTris.values()) {
    if (arr.length !== 2) continue;
    const [i, j] = arr;
    if (tris[i].n.dot(tris[j].n) > cosCop) {
      const a = find(i), b = find(j);
      if (a !== b) parent[a] = b;
    }
  }

  /* 分组 */
  const groups = new Map();
  tris.forEach((_, i) => {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(i);
  });

  const faces = [];
  for (const g of groups.values()) {
    if (g.length === 1) {
      const t = tris[g[0]];
      faces.push(makeFace([t.v[0], t.v[1], t.v[2]], t.n.clone(), verts));
      continue;
    }
    /* 组内只出现一次的有向边 = 多边形边界 */
    const cnt = new Map();
    for (const ti of g) {
      const [a, b, c] = tris[ti].v;
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const k = ekey(p, q);
        const rec = cnt.get(k);
        if (rec) rec.n++;
        else cnt.set(k, { n: 1, from: p, to: q });
      }
    }
    const next = new Map();
    for (const rec of cnt.values()) {
      if (rec.n !== 1) continue;
      let arr = next.get(rec.from);
      if (!arr) next.set(rec.from, (arr = []));
      arr.push(rec.to);
    }
    const start = next.keys().next().value;
    if (start === undefined) return null;
    const seq = [];
    let cur = start;
    let guard = 0;
    do {
      seq.push(cur);
      const arr = next.get(cur);
      if (!arr || !arr.length) return null;
      cur = arr.pop();
      if (++guard > next.size + 2) return null;
    } while (cur !== start);
    if (seq.length < 3) return null;
    faces.push(makeFace(seq, tris[g[0]].n.clone(), verts));
  }
  return faces;
}

/* ---------------------- 3. 面邻接边记录 ---------------------- */
function buildEdges(faces) {
  const map = new Map();
  faces.forEach((f, fi) => {
    const n = f.vids.length;
    for (let i = 0; i < n; i++) {
      const a = f.vids[i], b = f.vids[(i + 1) % n];
      const k = a < b ? a + '_' + b : b + '_' + a;
      let rec = map.get(k);
      if (!rec) map.set(k, (rec = { a: Math.min(a, b), b: Math.max(a, b), faces: [] }));
      if (!rec.faces.includes(fi)) rec.faces.push(fi);
    }
  });
  return map;
}

/* ------------------- 4. 判定凸硬棱并计算倒角量 ------------------- */
function computeCuts(edges, faces, verts, width) {
  const cuts = new Map();
  const cosMin = Math.cos((MIN_ANGLE * Math.PI) / 180);
  for (const [key, rec] of edges) {
    if (rec.faces.length !== 2) continue;                  // 开放边 / 非流形边
    const f1 = faces[rec.faces[0]];
    const f2 = faces[rec.faces[1]];
    const cos = f1.normal.dot(f2.normal);
    if (cos > cosMin || cos < -0.9) continue;              // 平滑面 / 折回面

    const a = verts[rec.a];
    const b = verts[rec.b];
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-9) continue;
    dir.divideScalar(len);
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);

    /* 凸棱判定：另一面“最远端顶点”位于本面内侧（凹棱则在外侧） */
    let h = Infinity;
    let convex = true;
    for (const [f, other] of [[f1, f2], [f2, f1]]) {
      let far = null, farD = -1;
      for (const id of f.vids) {
        if (id === rec.a || id === rec.b) continue;
        const d = _t.subVectors(verts[id], a).cross(dir).length();
        if (d > farD) { farD = d; far = verts[id]; }
      }
      if (!far) { convex = false; break; }
      if (_u.subVectors(far, mid).dot(other.normal) >= 0) { convex = false; break; }
      if (farD < h) h = farD;
    }
    if (!convex) continue;

    const cut = Math.min(width, h * MAX_CUT);
    if (cut > 1e-7) cuts.set(key, cut);
  }
  return cuts;
}

/* ---------------- 5. 面内角点：相邻内缩线求交 ---------------- */
function faceBasis(f, verts) {
  const origin = verts[f.vids[0]].clone();
  const ex = new THREE.Vector3().subVectors(verts[f.vids[1]], origin);
  if (ex.lengthSq() < 1e-20) return null;
  ex.normalize();
  const ey = new THREE.Vector3().crossVectors(f.normal, ex);
  if (ey.lengthSq() < 1e-20) return null;
  ey.normalize();                       // (ex, ey, normal) 构成右手系
  return { origin, ex, ey };
}

function computeCorners(faces, edges, cuts, verts) {
  const corners = new Map();            // 面序号 → 与 vids 同序的角点
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    const n = f.vids.length;
    const B = faceBasis(f, verts);
    if (!B) return null;
    const { origin, ex, ey } = B;
    const p2 = f.vids.map((id) => {
      const d = _t.subVectors(verts[id], origin);
      return [d.dot(ex), d.dot(ey)];
    });
    /* 多边形面积校验（绕向必须与法线一致） */
    let area = 0;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = p2[i];
      const [x2, y2] = p2[(i + 1) % n];
      area += x1 * y2 - x2 * y1;
    }
    if (!(area > 1e-12)) return null;

    /* 每条边的内法线（左法线，指向多边形内部）与内缩量 */
    const lines = [];
    for (let i = 0; i < n; i++) {
      const [ax, ay] = p2[i];
      const [bx, by] = p2[(i + 1) % n];
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1e-12) return null;
      const nx = -dy / len, ny = dx / len;
      const cut = cuts.get(edgeKeyOf(f.vids[i], f.vids[(i + 1) % n])) || 0;
      lines.push({ nx, ny, c: nx * ax + ny * ay + cut });
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const L1 = lines[(i - 1 + n) % n];
      const L2 = lines[i];
      const det = L1.nx * L2.ny - L1.ny * L2.nx;
      if (Math.abs(det) < PARALLEL) return null;   // 相邻边几乎平行 → 放弃
      const x = (L1.c * L2.ny - L2.c * L1.ny) / det;
      const y = (L1.nx * L2.c - L2.nx * L1.c) / det;
      out[i] = new THREE.Vector3(
        origin.x + ex.x * x + ey.x * y,
        origin.y + ex.y * x + ey.y * y,
        origin.z + ex.z * x + ey.z * y,
      );
    }
    corners.set(fi, out);
  }
  return corners;
}

/* 未倒角的棱：两侧必须共用同一角点，否则会留下发丝裂缝。
   做法：在每个顶点上，把由“未倒角棱”相连的面用并查集并成一组，
   组内角点统一取原始角点的平均值（角点都落在这些棱的公共线上，
   取平均只是把浮点误差抹平）。倒角棱两侧的面天然属于不同组，
   因此斜面的两个端点仍然是分开的。 */
function shareSeamCorners(edges, faces, cuts, corners) {
  const perVert = new Map();
  const getV = (vid) => {
    let r = perVert.get(vid);
    if (!r) perVert.set(vid, (r = { parent: new Map(), faces: new Set() }));
    return r;
  };
  const find = (r, x) => {
    let p = r.parent.get(x);
    if (p === undefined) { r.parent.set(x, x); return x; }
    if (p === x) return x;
    const root = find(r, p);
    r.parent.set(x, root);
    return root;
  };

  for (const [key, rec] of edges) {
    if (rec.faces.length !== 2) continue;
    const beveled = cuts.has(key);
    for (const vid of [rec.a, rec.b]) {
      const r = getV(vid);
      for (const fi of rec.faces) {
        if (!r.faces.has(fi)) { r.faces.add(fi); find(r, fi); }
      }
      if (!beveled) {
        const [f1, f2] = rec.faces;
        const a = find(r, f1);
        const b = find(r, f2);
        if (a !== b) r.parent.set(a, b);
      }
    }
  }

  for (const [vid, r] of perVert) {
    const groups = new Map();
    for (const fi of r.faces) {
      const root = find(r, fi);
      let g = groups.get(root);
      if (!g) groups.set(root, (g = []));
      const cs = corners.get(fi);
      const i = cs ? faces[fi].vids.indexOf(vid) : -1;
      if (i >= 0 && cs[i]) g.push({ fi, i, c: cs[i] });
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const mid = new THREE.Vector3();
      for (const it of g) mid.add(it.c);
      mid.multiplyScalar(1 / g.length);
      for (const it of g) corners.get(it.fi)[it.i] = mid.clone();
    }
  }
}

/* ------------- 6. 组装三角形：面片 + 斜面 + 顶点帽 ------------- */
function assemble(faces, edges, cuts, corners, verts, debug) {
  const tris = [];
  const push = (p, ref) => { tris.push({ p, ref }); };

  /* 6.1 内缩后的原面 */
  faces.forEach((f, fi) => {
    const cs = corners.get(fi);
    if (!cs || cs.length < 3) return;
    const c = new THREE.Vector3();
    for (const v of cs) c.add(v);
    c.multiplyScalar(1 / cs.length);
    for (let i = 0; i < cs.length; i++) {
      push([c, cs[i], cs[(i + 1) % cs.length]], f.normal);
    }
  });

  /* 6.2 每条硬棱一块窄斜面 */
  for (const [key, rec] of edges) {
    const cut = cuts.get(key);
    if (!cut || rec.faces.length !== 2) continue;
    const [fi1, fi2] = rec.faces;
    const f1 = faces[fi1];
    const f2 = faces[fi2];
    const c1 = corners.get(fi1);
    const c2 = corners.get(fi2);
    if (!c1 || !c2) continue;
    const i1a = f1.vids.indexOf(rec.a), i1b = f1.vids.indexOf(rec.b);
    const i2a = f2.vids.indexOf(rec.a), i2b = f2.vids.indexOf(rec.b);
    if (i1a < 0 || i1b < 0 || i2a < 0 || i2b < 0) continue;
    const A1 = c1[i1a], B1 = c1[i1b], A2 = c2[i2a], B2 = c2[i2b];
    const ref = new THREE.Vector3().addVectors(f1.normal, f2.normal);
    push([A1, B1, B2], ref);
    push([A1, B2, A2], ref);
  }

  /* 6.3 顶点帽：按网格拓扑绕顶点一圈，把各面角点连成多边形
     （必须用拓扑环序：按角度排序在角点较多时会把次序排错，
      补面会变成蝴蝶结形，边对不上就会出现开边） */
  const vertFaces = new Map();
  faces.forEach((f, fi) => {
    for (const vid of f.vids) {
      let arr = vertFaces.get(vid);
      if (!arr) vertFaces.set(vid, (arr = []));
      arr.push(fi);
    }
  });
  for (const [vid, fis] of vertFaces) {
    /* 沿共享边依次穿过顶点周围的各面 */
    const order = [];
    const seen = new Set();
    let cur = fis[0];
    let guard = 0;
    while (cur !== undefined && !seen.has(cur) && guard++ <= fis.length + 1) {
      seen.add(cur);
      order.push(cur);
      const f = faces[cur];
      const i = f.vids.indexOf(vid);
      const rec = edges.get(edgeKeyOf(vid, f.vids[(i + 1) % f.vids.length]));
      if (!rec || rec.faces.length !== 2) { cur = undefined; break; }
      cur = rec.faces[0] === cur ? rec.faces[1] : rec.faces[0];
    }
    if (order.length < 3 || order.length !== fis.length) {
      if (debug) debug.capSkip = (debug.capSkip || 0) + 1;
      continue;                                    // 顶点环不完整，不补帽
    }
    const pts = [];
    const axis = new THREE.Vector3();
    for (const fi of order) {
      const f = faces[fi];
      const i = f.vids.indexOf(vid);
      const c = corners.get(fi) ? corners.get(fi)[i] : null;
      if (!c) continue;
      axis.add(f.normal);
      if (!pts.length || pts[pts.length - 1].distanceToSquared(c) > 1e-18) pts.push(c);
    }
    /* 首尾重合（未倒角棱两侧共用角点）要去掉 */
    while (pts.length > 1 && pts[0].distanceToSquared(pts[pts.length - 1]) < 1e-18) pts.pop();
    if (pts.length < 3 || axis.lengthSq() < 1e-12) {
      if (debug) debug.capSkip = (debug.capSkip || 0) + 1;
      continue;
    }
    const c = new THREE.Vector3();
    for (const p of pts) c.add(p);
    c.multiplyScalar(1 / pts.length);
    if (debug) debug.caps = (debug.caps || 0) + 1;
    for (let i = 0; i < pts.length; i++) {
      push([c, pts[i], pts[(i + 1) % pts.length]], axis);
    }
  }
  return tris;
}

/* ---------- 7. 输出几何：逐面定向 + 按夹角焊接法线 ---------- */
function buildGeometry(tris, size) {
  const eps = Math.max(1e-6, size * 1e-5);
  const items = [];
  for (const t of tris) {
    const [a, b, c] = t.p;
    const n = new THREE.Vector3()
      .subVectors(b, a)
      .cross(_t.subVectors(c, a));
    if (n.lengthSq() < 1e-24) continue;          // 退化三角形丢弃
    n.normalize();
    let p = t.p;
    if (t.ref && n.dot(t.ref) < 0) { p = [a, c, b]; n.negate(); }
    items.push({ p, n });
  }
  if (!items.length) return null;

  /* 同位置角点分组，夹角小于 SMOOTH 的共享平滑法线（保留斜面棱线的硬边） */
  const keyOf = (v) =>
    Math.round(v.x / eps) + ',' + Math.round(v.y / eps) + ',' + Math.round(v.z / eps);
  const groups = new Map();
  items.forEach((it, ti) => {
    it.p.forEach((v, ci) => {
      const k = keyOf(v);
      let arr = groups.get(k);
      if (!arr) groups.set(k, (arr = []));
      arr.push({ ti, ci });
    });
  });
  const cosSmooth = Math.cos((SMOOTH * Math.PI) / 180);
  const normals = items.map(() => [null, null, null]);
  for (const arr of groups.values()) {
    for (const a of arr) {
      const na = items[a.ti].n;
      const sum = new THREE.Vector3();
      for (const b of arr) {
        const nb = items[b.ti].n;
        if (na.dot(nb) >= cosSmooth) sum.add(nb);
      }
      normals[a.ti][a.ci] = sum.lengthSq() > 1e-12 ? sum.normalize() : na.clone();
    }
  }

  const positions = new Float32Array(items.length * 9);
  const normalArr = new Float32Array(items.length * 9);
  let o = 0;
  items.forEach((it, ti) => {
    for (let ci = 0; ci < 3; ci++) {
      const p = it.p[ci];
      const n = normals[ti][ci] || it.n;
      positions[o] = p.x; positions[o + 1] = p.y; positions[o + 2] = p.z;
      normalArr[o] = n.x; normalArr[o + 1] = n.y; normalArr[o + 2] = n.z;
      o += 3;
    }
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normalArr, 3));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}
