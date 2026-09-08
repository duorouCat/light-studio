/* =====================================================================
 *  光影实验室 · Light Studio
 *  基于 Three.js 的 3D 光影演示与调节工具
 * ===================================================================== */
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { bevelGeometry } from './bevel.js';

/* ------------------------------ 工具 ------------------------------ */
const $ = (sel) => document.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const deg2rad = (d) => (d * Math.PI) / 180;
const fmt = (v) => String(Math.round(v * 100) / 100);

/** 开尔文色温 → 线性 RGB（Tanner Helland 近似） */
function kelvinToRGB(k) {
  const t = clamp(k, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) r = 255;
  else r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
  if (t <= 66) g = 99.4708025861 * Math.log(t) - 161.1195681661;
  else g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [clamp(r, 0, 255) / 255, clamp(g, 0, 255) / 255, clamp(b, 0, 255) / 255];
}
const kelvinToHex = (k) =>
  '#' + kelvinToRGB(k).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
const lightColor = (def) =>
  def.custom ? new THREE.Color(def.customColor) : new THREE.Color(...kelvinToRGB(def.kelvin));

/* --------------------------- 渲染器与场景 --------------------------- */
const canvas = $('#scene-canvas');
const viewport = $('#viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.useLegacyLights = true; // 经典光照标定：点/聚光强度 0-10 量级，兼容性最佳

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
camera.position.set(0, 5.2, 15.5);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 4;
controls.maxDistance = 60;
controls.maxPolarAngle = Math.PI / 2; // 允许仰角降到 0°（相机与目标同高），且不会低于地面
controls.autoRotateSpeed = 0.8;

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

/* ---------------------------- 地面与网格 ---------------------------- */
/* 地面使用受光材质：点/聚光灯的光斑（圆形/锥形）与阴影都能在地面显示 */
const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x151b28, roughness: 0.95, metalness: 0 });
/* 深度偏移：模型面平贴地面（y=0 重合）时不产生闪烁，地面被轻微推后 */
groundMaterial.polygonOffset = true;
groundMaterial.polygonOffsetFactor = 1;
groundMaterial.polygonOffsetUnits = 1;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const GRID_DIVISIONS = 36;
const grid = new THREE.GridHelper(GRID_DIVISIONS, GRID_DIVISIONS, 0x8a93a8, 0x3a4152);
grid.material.transparent = true;
grid.material.opacity = 0.4;
grid.position.y = 0.01;
scene.add(grid);
let showGrid = true;

/* r160 的 GridHelper 没有 setColors 方法，手动更新顶点颜色实现网格换色 */
function setGridColors(centerColor, gridColor) {
  const attr = grid.geometry.attributes.color;
  if (!attr) return;
  const a = new THREE.Color(centerColor);
  const b = new THREE.Color(gridColor);
  const arr = attr.array;
  const center = GRID_DIVISIONS / 2;
  for (let i = 0; i <= GRID_DIVISIONS; i++) {
    const c = i === center ? a : b;
    const off = i * 12; // 每条线 4 个顶点 × 3 分量
    for (let k = 0; k < 4; k++) {
      arr[off + k * 3] = c.r;
      arr[off + k * 3 + 1] = c.g;
      arr[off + k * 3 + 2] = c.b;
    }
  }
  attr.needsUpdate = true;
}

/* 各背景对应的地面与网格配色（保证光斑/网格在各种背景下可见） */
const BG_STYLES = {
  studio: { floor: 0x151b28, gridA: 0x8a93a8, gridB: 0x3a4152 },
  day:    { floor: 0xcfd9e8, gridA: 0x5a6a85, gridB: 0x94a4bd },
  dusk:   { floor: 0x7a5a45, gridA: 0xb08a6a, gridB: 0x6a4a3a },
  night:  { floor: 0x101724, gridA: 0x6a7488, gridB: 0x2c3345 },
};

/* --------------------- 实时环境反射（IBL） --------------------- */
/* 金属只有“照出真实的东西”才有意义。做法：
   用 CubeCamera 把当前场景实时渲染成立方体贴图（含光源标记、地面、网格、
   天空渐变），再经 PMREM 预滤波作为环境贴图 —— 于是：
     · 金属表面真实反射光源：光源挪到哪儿，反射里的光点就跟到哪儿；
     · 粗糙度越低反射越清晰锐利、越高越模糊（光点被糊开、地平线变柔），差别一眼可见。
   捕捉时把模型自身隐藏，避免自反射反馈；光源标记即使被用户隐藏也照常参与反射，
   并临时提亮，让镜面里出现清晰的光源高光。 */
let envI = 0.7; // 环境反射强度（全局可调）

const ENV_SIZE = 256;        // 立方体贴图边长
const ENV_INTERVAL = 0.2;    // 刷新间隔（秒），拖动光源时也能跟手
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
pmrem.compileCubemapShader();

const envRT = new THREE.WebGLCubeRenderTarget(ENV_SIZE, { type: THREE.HalfFloatType });
const envCam = new THREE.CubeCamera(0.1, 150, envRT);
scene.add(envCam);

let envPMREM = null;
let envDirty = true;
const markEnvDirty = () => { envDirty = true; };

/* 捕捉立方体贴图时的天空背景：只给一个平滑的天地渐变，
   亮的部分交给真实光源（不再画假的柔光箱亮斑） */
const SKY_STYLES = {
  studio: { top: '#6b7488', horizon: '#3a4356', ground: '#1a1f2b', floor: '#0a0d13' },
  day:    { top: '#dcebff', horizon: '#c2d8f0', ground: '#7f8ea6', floor: '#4a5668' },
  dusk:   { top: '#3f4f7a', horizon: '#c9773f', ground: '#3a2a24', floor: '#151013' },
  night:  { top: '#1b2740', horizon: '#101a2c', ground: '#080b12', floor: '#04060a' },
};
const skyCache = new Map();

function skyTexture(style) {
  const key = SKY_STYLES[style] ? style : 'studio';
  let tex = skyCache.get(key);
  if (tex) return tex;
  const W = 512, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  const s = SKY_STYLES[key];
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, s.top);
  g.addColorStop(0.49, s.horizon);
  g.addColorStop(0.52, s.ground);
  g.addColorStop(1, s.floor);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  skyCache.set(key, tex);
  return tex;
}

/* 重新捕捉环境贴图：真实场景 → 立方体贴图 → PMREM 预滤波 */
function refreshEnvironment() {
  const sky = skyTexture(bg);
  const prevBg = scene.background;
  const hidden = [];
  for (const e of modelEntries) {
    if (e.group.visible) { hidden.push(e.group); e.group.visible = false; }
  }
  /* 光源标记：参与反射并临时提亮 / 固定大小（自检光点清晰、不闪烁） */
  const markerBackup = markers.map((m, i) => {
    const backup = {
      m,
      wasVisible: m.group.visible,
      sphereColor: m.sphere.material.color.clone(),
      lineColor: m.line.material.color.clone(),
      scale: m.sphere.scale.x,
    };
    m.group.visible = lightDefs[i].enabled && i < lightCount;
    m.sphere.material.color.multiplyScalar(6);
    m.line.material.color.multiplyScalar(4);
    m.sphere.scale.setScalar(1);
    return backup;
  });
  const entry = currentEntry();
  if (entry) {
    envCam.position.set(
      entry.group.position.x,
      entry.group.position.y + entry.mesh.position.y,
      0,
    );
  }
  let next = null;
  const shadowAuto = renderer.shadowMap.autoUpdate;
  try {
    scene.background = sky;
    /* 阴影贴图是从“灯”的视角渲的，各面共用上一帧的结果即可，省掉 6 次阴影重渲 */
    renderer.shadowMap.autoUpdate = false;
    envCam.update(renderer, scene);
    next = pmrem.fromCubemap(envRT.texture);
  } catch (err) {
    console.warn('实时环境捕捉失败，退回程序化天空', err);
    try {
      next = pmrem.fromEquirectangular(sky);
    } catch {}
  } finally {
    renderer.shadowMap.autoUpdate = shadowAuto;
    scene.background = prevBg;
    for (const g of hidden) g.visible = true;
    for (const b of markerBackup) {
      b.m.group.visible = b.wasVisible;
      b.m.sphere.material.color.copy(b.sphereColor);
      b.m.line.material.color.copy(b.lineColor);
      b.m.sphere.scale.setScalar(b.scale);
    }
  }
  if (!next) return;
  const old = envPMREM;
  envPMREM = next;
  scene.environment = next.texture;
  if (old) old.dispose();
}

/* 环境反射强度：模型用完整强度，地面压暗一些，避免地面反射盖过阴影 */
function applyEnvIntensity() {
  for (const e of modelEntries) e.mesh.material.envMapIntensity = envI;
  groundMaterial.envMapIntensity = envI * 0.3;
}

/* ------------------------------ 模型 ------------------------------ */
const MODEL_DEFS = [
  { id: 'box',    name: '立方体',   baseY: 0.70, ring: 1.20, kind: 'none',   flat: false, color: '#e6b56a', build: (s) => new THREE.BoxGeometry(1.4, 1.4, 1.4) },
  { id: 'sphere', name: '球体',     baseY: 0.85, ring: 1.00, kind: 'seg',    segLabel: '球面段数', flat: false, color: '#7fb8e6', build: (s) => new THREE.SphereGeometry(0.85, s.seg, Math.max(8, Math.round(s.seg / 2))) },
  { id: 'cyl',    name: '圆柱',     baseY: 0.75, ring: 1.00, kind: 'seg',    segLabel: '径向段数', flat: false, color: '#d8b06a', build: (s) => new THREE.CylinderGeometry(0.75 * s.topRatio, 0.75, 1.5, s.seg, 1, false) },
  { id: 'cone',   name: '圆锥',     baseY: 0.80, ring: 1.00, kind: 'seg',    segLabel: '径向段数', flat: false, color: '#e6a06f', build: (s) => new THREE.ConeGeometry(0.9, 1.6, s.seg, 1, false) },
  { id: 'tetra',  name: '四面体',   baseY: 0.95, ring: 1.00, kind: 'detail', faceSnapDefault: true, flat: true,  color: '#7fd8a4', build: (s) => new THREE.TetrahedronGeometry(0.95, s.detail) },
  { id: 'octa',   name: '八面体',   baseY: 0.95, ring: 1.00, kind: 'detail', faceSnapDefault: true, flat: true,  color: '#e07f9e', build: (s) => new THREE.OctahedronGeometry(0.95, s.detail) },
  { id: 'icosa',  name: '二十面体', baseY: 0.95, ring: 1.00, kind: 'detail', faceSnapDefault: true, flat: true,  color: '#b48fe6', build: (s) => new THREE.IcosahedronGeometry(0.95, s.detail) },
  { id: 'dodeca', name: '十二面体', baseY: 0.95, ring: 1.00, kind: 'detail', faceSnapDefault: true, flat: true,  color: '#e6a07f', build: (s) => new THREE.DodecahedronGeometry(0.95, s.detail) },
  { id: 'knot',   name: '圆环结',   baseY: 0.62, ring: 1.05, kind: 'seg',    segLabel: '管状段数', flat: false, color: '#8fe6d2', build: (s) => new THREE.TorusKnotGeometry(0.52, 0.17, s.seg, 8) },
];

const wrapDeg = (d) => ((Math.round(d) % 360) + 360) % 360;
const defaultModelState = (def) => {
  const st = {
    color: def.color,
    metalness: 0.25,
    roughness: 0.38,
    sx: 1, sy: 1, sz: 1,
    rx: 0, ry: 0, rz: 0,
    seg: 32,
    detail: 0,
    topRatio: 1,
    bevel: 0.03,
    wire: false,
    edges: false,
    spin: 0,
  };
  if (def.faceSnapDefault) {
    /* 默认让一个平面朝下贴地：取首个面的法线旋转到竖直向下，多面体不再顶点/棱着地 */
    const g = def.build(st);
    const pos = g.attributes.position;
    const a = new THREE.Vector3().fromBufferAttribute(pos, 0);
    const b = new THREE.Vector3().fromBufferAttribute(pos, 1);
    const c = new THREE.Vector3().fromBufferAttribute(pos, 2);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.lengthSq() > 1e-8) {
      n.normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, -1, 0));
      const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
      st.rx = wrapDeg((e.x * 180) / Math.PI);
      st.ry = wrapDeg((e.y * 180) / Math.PI);
      st.rz = wrapDeg((e.z * 180) / Math.PI);
    }
    g.dispose();
  }
  return st;
};
const modelState = {};
MODEL_DEFS.forEach((d) => (modelState[d.id] = defaultModelState(d)));

let selectedId = 'box';
let shownIds = new Set(['box']);
let faceSnapMode = false;
let addMode = true; // 模型选择模式：true=添加模式，false=替换模式
const currentEntry = () => modelEntries.find((e) => e.def.id === selectedId);

/* 选中指示：地面金色圆环（不随模型旋转，稳定美观） */
const selRing = new THREE.Mesh(
  new THREE.RingGeometry(0.88, 1.0, 64),
  new THREE.MeshBasicMaterial({ color: 0xffd166, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false })
);
selRing.rotation.x = -Math.PI / 2;
selRing.position.y = 0.02;
scene.add(selRing);

function updateSelectionRing() {
  const entry = currentEntry();
  selRing.position.x = entry.group.position.x;
  selRing.scale.set(entry.halfWidth, entry.halfDepth, 1);
}


/* 多模型陈列布局：按各自占地宽度自动排开、整体居中 */
function layoutModels() {
  const shown = modelEntries.filter((e) => e.group.visible);
  const gap = 0.9;
  let x = 0;
  for (const e of shown) {
    x += e.halfWidth;
    e.group.position.x = x;
    x += e.halfWidth + gap;
  }
  const total = Math.max(x - gap, 0);
  for (const e of shown) e.group.position.x -= total / 2;
  markEnvDirty();
}

/* 生成模型几何：先按参数建模，再按需“锉边”（硬棱磨成窄斜面）。
   锉边失败（例如没有硬棱、几何退化）时静默回退到原始几何，不影响使用。 */
function buildGeometryFor(def, st) {
  const base = def.build(st);
  const w = Number(st.bevel);
  if (!(w > 0)) return base;
  let bev = null;
  try {
    bev = bevelGeometry(base, w);
  } catch (err) {
    console.warn('锉边计算失败，改用原始几何', err);
  }
  if (bev) {
    base.dispose();
    return bev;
  }
  return base;
}

const modelEntries = MODEL_DEFS.map((def) => {
  const st = modelState[def.id];
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(buildGeometryFor(def, st), new THREE.MeshStandardMaterial({ flatShading: def.flat }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  /* 边线叠加层：挂在 mesh 下自动继承缩放/旋转/贴地，微放大避免与面重叠闪烁 */
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.9 })
  );
  edges.scale.setScalar(1.002);
  edges.visible = false;
  mesh.add(edges);
  group.add(mesh);
  group.visible = false;
  scene.add(group);
  return { def, group, mesh, edges, state: st };
});

function applyModel(entry) {
  const st = entry.state;
  const m = entry.mesh;
  m.scale.set(st.sx, st.sy, st.sz);
  m.rotation.set(deg2rad(st.rx), deg2rad(st.ry), deg2rad(st.rz));
  m.position.y = entry.def.baseY * st.sy;
  entry.group.position.y = 0;
  const mat = m.material;
  mat.color.set(st.color);
  mat.metalness = st.metalness;
  mat.roughness = st.roughness;
  mat.envMapIntensity = envI;
  mat.wireframe = st.wire;
  entry.edges.visible = st.edges;
  entry.edges.material.color.set(new THREE.Color(st.color).multiplyScalar(0.3));
  computeFootprint(entry);
  layoutModels();
  if (entry.def.id === selectedId) updateSelectionRing();
}

/* 依据缩放+朝向计算占地（贴地高度 / XZ 半径），用于自动布局与地面圆环 */
function computeFootprint(entry) {
  const m = entry.mesh;
  const g = m.geometry;
  const pos = g.attributes.position;
  if (!pos) {
    /* 数据异常时的安全兜底，避免模型被放到无限远而不可见 */
    entry.halfWidth = 1.2;
    entry.halfDepth = 1.2;
    entry.group.position.y = 0.5;
    return;
  }
  m.updateMatrix();
  const mat4 = m.matrix;
  const tmp = new THREE.Vector3();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, minZ = Infinity, maxZ = -Infinity;
  /* 按全部顶点精确计算旋转/缩放后的占地（包围盒角点法在旋转后会把模型抬高） */
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i).applyMatrix4(mat4);
    if (tmp.x < minX) minX = tmp.x;
    if (tmp.x > maxX) maxX = tmp.x;
    if (tmp.y < minY) minY = tmp.y;
    if (tmp.z < minZ) minZ = tmp.z;
    if (tmp.z > maxZ) maxZ = tmp.z;
  }
  entry.halfWidth = (maxX - minX) / 2 + 0.2;
  entry.halfDepth = (maxZ - minZ) / 2 + 0.2;
  if (!isFinite(entry.halfWidth) || !isFinite(minY)) {
    entry.halfWidth = 1.2;
    entry.halfDepth = 1.2;
    entry.group.position.y = 0.5;
    return;
  }
  entry.group.position.y = -minY; // 模型最低点时刻贴地：吸附面平放时与地面正好重合
}


function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function rebuildModel(entry) {
  entry.mesh.geometry.dispose();
  entry.mesh.geometry = buildGeometryFor(entry.def, entry.state);
  entry.edges.geometry.dispose();
  entry.edges.geometry = new THREE.EdgesGeometry(entry.mesh.geometry);
  applyModel(entry);
}
modelEntries.forEach(applyModel);

/* ---------------------------- 灯光系统 ---------------------------- */
const MAX_LIGHTS = 6;
const TYPE_MAX = { directional: 10, point: 10, spot: 10 };

const defaultLightDefs = () => [
  { type: 'directional', kelvin: 6500, intensity: 2.5, azimuth: 0,    elevation: 45, distance: 7, custom: false, customColor: '#ffffff', shadow: true,  enabled: true,  angle: 30, penumbra: 0.5 },
  { type: 'point',       kelvin: 4000, intensity: 4,   azimuth: 95,   elevation: 22, distance: 7, custom: false, customColor: '#ffffff', shadow: false, enabled: true,  angle: 30, penumbra: 0.5 },
  { type: 'point',       kelvin: 8000, intensity: 5,   azimuth: 200,  elevation: 45, distance: 7, custom: false, customColor: '#ffffff', shadow: false, enabled: false, angle: 30, penumbra: 0.5 },
  { type: 'spot',        kelvin: 5500, intensity: 6,   azimuth: -150, elevation: 55, distance: 9, custom: false, customColor: '#ffffff', shadow: false, enabled: false, angle: 28, penumbra: 0.5 },
  { type: 'directional', kelvin: 3000, intensity: 1.5, azimuth: 150,  elevation: 15, distance: 7, custom: false, customColor: '#ffffff', shadow: false, enabled: false, angle: 30, penumbra: 0.5 },
  { type: 'point',       kelvin: 2000, intensity: 6,   azimuth: 0,    elevation: 8,  distance: 6, custom: false, customColor: '#ffffff', shadow: false, enabled: false, angle: 30, penumbra: 0.5 },
];
let lightCount = 1;
const lightDefs = defaultLightDefs();

const ambient = new THREE.AmbientLight(0xffffff, 0.5);
const hemi = new THREE.HemisphereLight(0xffffff, 0x2f3340, 0.4);
hemi.visible = false;
scene.add(ambient, hemi);

function createLightObject(type) {
  let light;
  if (type === 'directional') light = new THREE.DirectionalLight(0xffffff, 1);
  else if (type === 'point') light = new THREE.PointLight(0xffffff, 1, 25, 2);
  else light = new THREE.SpotLight(0xffffff, 1, 25, 0.5, 0.4, 2);
  light.castShadow = false;
  const target = new THREE.Object3D();
  target.position.set(0, 0.9, 0);
  light.target = target;
  if (type === 'directional') {
    light.shadow.mapSize.set(2048, 2048);
    const sc = light.shadow.camera;
    sc.left = -11; sc.right = 11; sc.top = 11; sc.bottom = -11;
    sc.near = 1; sc.far = 45;
    sc.updateProjectionMatrix();
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.02;
  } else {
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.camera.near = 0.5;
    light.shadow.camera.far = 45;
    light.shadow.bias = -0.0002;
    light.shadow.normalBias = 0.01;
  }
  scene.add(light, target);
  return { light, target };
}

const lightObjs = lightDefs.map((d) => createLightObject(d.type));

function swapLightObject(i) {
  const old = lightObjs[i];
  scene.remove(old.light, old.target);
  old.light.dispose();
  if (old.light.shadow) old.light.shadow.dispose();
  lightObjs[i] = createLightObject(lightDefs[i].type);
}

/* 灯光对象类型是否与配置一致（平行光/点光源/聚光灯） */
function lightTypeMatches(light, type) {
  return (
    (type === 'directional' && light.isDirectionalLight) ||
    (type === 'point' && light.isPointLight) ||
    (type === 'spot' && light.isSpotLight)
  );
}

/* 配置切换/加载后，重建与配置类型不一致的灯光对象 */
function reconcileLightObjects() {
  lightDefs.forEach((d, i) => {
    if (!lightTypeMatches(lightObjs[i].light, d.type)) swapLightObject(i);
  });
}

function lightPosition(def) {
  const az = deg2rad(def.azimuth);
  const el = deg2rad(def.elevation);
  const d = def.distance;
  return new THREE.Vector3(d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az));
}

function updateLight(i) {
  const def = lightDefs[i];
  const { light, target } = lightObjs[i];
  light.color.copy(lightColor(def));
  light.intensity = def.intensity;
  light.visible = def.enabled && i < lightCount;
  light.castShadow = def.shadow && light.visible;
  target.position.set(0, 0.9, 0);
  if (def.type === 'spot') {
    light.angle = deg2rad(def.angle);
    light.penumbra = def.penumbra;
    light.shadow.camera.fov = def.angle * 2;
    light.shadow.camera.updateProjectionMatrix();
  }
  light.position.copy(lightPosition(def));
  updateMarker(i);
  markEnvDirty();
}
const updateAllLights = () => lightDefs.forEach((_, i) => updateLight(i));

/* --------------------------- 光源标记 --------------------------- */
const TARGET_POS = new THREE.Vector3(0, 0.9, 0);
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

function createMarker() {
  const group = new THREE.Group();
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 16, 16),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    })
  );
  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const line = new THREE.Line(
    lineGeo,
    new THREE.LineBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.35, depthWrite: false })
  );
  const arrow = new THREE.ArrowHelper(UP, new THREE.Vector3(), 1.3, 0xffffff, 0.32, 0.18);
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.3, 1, 20, 1, true),
    new THREE.MeshBasicMaterial({ wireframe: true, color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.3, depthWrite: false })
  );
  group.add(sphere, line, arrow, cone);
  scene.add(group);
  return { group, sphere, line, arrow, cone };
}
const markers = lightDefs.map(() => createMarker());

function updateMarker(i) {
  const def = lightDefs[i];
  const m = markers[i];
  const pos = lightPosition(def);
  const color = lightColor(def);
  m.sphere.position.copy(pos);
  m.sphere.material.color.copy(color);
  const linePos = m.line.geometry.attributes.position;
  linePos.setXYZ(0, pos.x, pos.y, pos.z);
  linePos.setXYZ(1, TARGET_POS.x, TARGET_POS.y, TARGET_POS.z);
  linePos.needsUpdate = true;
  m.line.material.color.copy(color);
  const dir = TARGET_POS.clone().sub(pos).normalize();
  m.arrow.visible = def.type === 'directional';
  if (def.type === 'directional') {
    m.arrow.position.copy(pos);
    m.arrow.setDirection(dir);
    m.arrow.setColor(color);
    m.arrow.setLength(1.3, 0.32, 0.18);
  }
  m.cone.visible = def.type === 'spot';
  if (def.type === 'spot') {
    const h = def.distance * 0.8;
    const r = Math.tan(deg2rad(def.angle) / 2) * h + 0.06;
    m.cone.geometry.dispose();
    m.cone.geometry = new THREE.ConeGeometry(r, h, 24, 1, true);
    m.cone.position.copy(pos).addScaledVector(dir, h / 2);
    m.cone.quaternion.setFromUnitVectors(UP, dir.clone().negate());
    m.cone.material.color.copy(color);
  }
}

let showMarkers = true;
function refreshMarkers() {
  lightDefs.forEach((d, i) => {
    markers[i].group.visible = showMarkers && d.enabled && i < lightCount;
  });
  markEnvDirty();
}

/* --------------------------- 全局光照参数 --------------------------- */
let ambientI = 0.5;
let ambientK = 6500;
let hemiOn = false;
let hemiI = 0.4;
let exposure = 1;
let bg = 'studio';
let autorotate = false;

function updateGlobalLights() {
  ambient.color.setRGB(...kelvinToRGB(ambientK));
  ambient.intensity = ambientI;
  hemi.visible = hemiOn;
  hemi.intensity = hemiI;
  hemi.color.setRGB(...kelvinToRGB(ambientK));
  renderer.toneMappingExposure = exposure;
  viewport.classList.remove('bg-studio', 'bg-day', 'bg-dusk', 'bg-night');
  viewport.classList.add('bg-' + bg);
  const bs = BG_STYLES[bg] ?? BG_STYLES.studio;
  ground.material.color.setHex(bs.floor);
  setGridColors(bs.gridA, bs.gridB);
  markEnvDirty();
  applyEnvIntensity();
}

/* ------------------------------ 预设 ------------------------------ */
const PRESETS = [
  {
    name: '影棚标准', count: 1, bg: 'studio', exposure: 1.0, env: 0.6,
    ambient: { i: 0.5, k: 6500 }, hemi: { on: false, i: 0.4 },
    defs: [
      { type: 'directional', kelvin: 6500, intensity: 2.5, azimuth: 0, elevation: 45, distance: 7, custom: false, customColor: '#ffffff', shadow: true, enabled: true, angle: 30, penumbra: 0.5 },
      { type: 'point', kelvin: 4000, intensity: 4, azimuth: 95, elevation: 22, distance: 7, custom: false, customColor: '#ffffff', shadow: false, enabled: true, angle: 30, penumbra: 0.5 },
    ],
  },
  {
    name: '正午日光', count: 2, bg: 'day', exposure: 1.15, env: 0.85,
    ambient: { i: 0.35, k: 7000 }, hemi: { on: true, i: 0.45 },
    defs: [
      { type: 'directional', kelvin: 5800, intensity: 4, azimuth: -15, elevation: 68, distance: 8, custom: false, customColor: '#ffffff', shadow: true, enabled: true, angle: 30, penumbra: 0.5 },
      { type: 'point', kelvin: 7000, intensity: 3, azimuth: 140, elevation: 18, distance: 7, custom: false, customColor: '#ffffff', shadow: false, enabled: true, angle: 30, penumbra: 0.5 },
    ],
  },
  {
    name: '日出黄昏', count: 2, bg: 'dusk', exposure: 1.05, env: 0.45,
    ambient: { i: 0.15, k: 2200 }, hemi: { on: false, i: 0.2 },
    defs: [
      { type: 'directional', kelvin: 2400, intensity: 2, azimuth: -55, elevation: 10, distance: 8, custom: false, customColor: '#ffffff', shadow: true, enabled: true, angle: 30, penumbra: 0.5 },
      { type: 'point', kelvin: 2000, intensity: 5, azimuth: 95, elevation: 6, distance: 7, custom: false, customColor: '#ffffff', shadow: false, enabled: true, angle: 30, penumbra: 0.5 },
    ],
  },
  {
    name: '清冷月光', count: 2, bg: 'night', exposure: 0.9, env: 0.35,
    ambient: { i: 0.1, k: 9000 }, hemi: { on: false, i: 0.15 },
    defs: [
      { type: 'directional', kelvin: 9500, intensity: 1, azimuth: -40, elevation: 42, distance: 8, custom: false, customColor: '#ffffff', shadow: true, enabled: true, angle: 30, penumbra: 0.5 },
      { type: 'point', kelvin: 8000, intensity: 1.2, azimuth: 160, elevation: 25, distance: 7, custom: false, customColor: '#ffffff', shadow: false, enabled: true, angle: 30, penumbra: 0.5 },
    ],
  },
  {
    name: '舞台霓虹', count: 4, bg: 'night', exposure: 1.0, env: 0.4,
    ambient: { i: 0.05, k: 4000 }, hemi: { on: false, i: 0.1 },
    defs: [
      { type: 'point', kelvin: 4000, intensity: 6, azimuth: -75, elevation: 15, distance: 6, custom: true, customColor: '#ff2d78', shadow: false, enabled: true, angle: 30, penumbra: 0.5 },
      { type: 'point', kelvin: 4000, intensity: 6, azimuth: 75, elevation: 15, distance: 6, custom: true, customColor: '#00e0ff', shadow: false, enabled: true, angle: 30, penumbra: 0.5 },
      { type: 'point', kelvin: 4000, intensity: 5, azimuth: 0, elevation: 48, distance: 7, custom: true, customColor: '#ffb300', shadow: false, enabled: true, angle: 30, penumbra: 0.5 },
      { type: 'point', kelvin: 4000, intensity: 4, azimuth: 180, elevation: 20, distance: 6, custom: true, customColor: '#8a5cff', shadow: false, enabled: true, angle: 30, penumbra: 0.5 },
    ],
  },
  {
    name: '影棚柔光', count: 4, bg: 'studio', exposure: 1.1, env: 0.7,
    ambient: { i: 0.42, k: 6000 }, hemi: { on: true, i: 0.3 },
    defs: [
      { type: 'directional', kelvin: 5500, intensity: 1.6, azimuth: 0, elevation: 38, distance: 8, custom: false, customColor: '#ffffff', shadow: true, enabled: true, angle: 30, penumbra: 0.5 },
      { type: 'point', kelvin: 5000, intensity: 3.5, azimuth: 105, elevation: 10, distance: 7, custom: false, customColor: '#ffffff', shadow: false, enabled: true, angle: 30, penumbra: 0.5 },
      { type: 'point', kelvin: 5000, intensity: 3.5, azimuth: -105, elevation: 10, distance: 7, custom: false, customColor: '#ffffff', shadow: false, enabled: true, angle: 30, penumbra: 0.5 },
      { type: 'spot', kelvin: 4500, intensity: 7, azimuth: 175, elevation: 55, distance: 9, custom: false, customColor: '#ffffff', shadow: false, enabled: true, angle: 42, penumbra: 0.6 },
    ],
  },
];

function applyPreset(idx) {
  const p = PRESETS[idx];
  lightCount = p.count;
  lightDefs.forEach((d, i) => {
    Object.assign(d, p.defs[i] ?? defaultLightDefs()[i]);
  });
  reconcileLightObjects();
  ambientI = p.ambient.i;
  ambientK = p.ambient.k;
  hemiOn = p.hemi.on;
  hemiI = p.hemi.i;
  exposure = p.exposure;
  bg = p.bg;
  envI = p.env ?? envI;
  $('#preset-select').value = String(idx);
  syncGlobalUI();
  updateGlobalLights();
  updateAllLights();
  renderLightUI();
  refreshMarkers();
  scheduleSave();
}

/* ------------------------------ 模型 UI ------------------------------ */
function buildModelButtons() {
  const wrap = $('#model-buttons');
  MODEL_DEFS.forEach((def) => {
    const b = document.createElement('button');
    b.className = 'model-btn';
    b.dataset.id = def.id;
    b.textContent = def.name;
    b.addEventListener('click', () => toggleModel(def.id));
    wrap.append(b);
  });
}

function refreshModelButtons() {
  document.querySelectorAll('.model-btn').forEach((b) => {
    b.classList.toggle('on', shownIds.has(b.dataset.id));
    b.classList.toggle('active', b.dataset.id === selectedId);
  });
  const countEl = $('#model-count');
  if (countEl) {
    const modeText = addMode ? '添加模式（点击按钮增减模型）' : '替换模式（点击按钮只展示该模型）';
    countEl.textContent = `正在展示 ${shownIds.size} / ${MODEL_DEFS.length} 个模型 · ${modeText}`;
  }
}

function applyVisibility() {
  modelEntries.forEach((e) => (e.group.visible = shownIds.has(e.def.id)));
}

function toggleModel(id) {
  if (!addMode) {
    /* 替换模式：点击后只展示该模型 */
    if (shownIds.has(id) && shownIds.size === 1) {
      selectModel(id); // 已是唯一展示模型，仅切换编辑目标
      return;
    }
    shownIds = new Set([id]);
    selectModel(id);
    return;
  }
  if (shownIds.has(id)) {
    if (shownIds.size === 1) return; // 至少展示一个模型
    shownIds.delete(id);
    selectModel(selectedId === id ? [...shownIds][0] : selectedId);
  } else {
    shownIds.add(id);
    selectModel(id);
  }
}

function selectModel(id) {
  selectedId = id;
  applyVisibility();
  layoutModels();
  refreshModelButtons();
  updateSelectionRing();
  buildModelParams();
  scheduleSave();
}

function buildModelParams() {
  const st = modelState[selectedId];
  const def = MODEL_DEFS.find((d) => d.id === selectedId);
  const wrap = $('#model-params');
  wrap.innerHTML = '';
  const row = (label) => {
    const r = document.createElement('div');
    r.className = 'ctrl-row';
    const lab = document.createElement('span');
    lab.className = 'ctrl-label';
    lab.textContent = label;
    r.append(lab);
    wrap.append(r);
    return r;
  };
  /* 滑杆 + 可直接输入数值的数字框（双向同步） */
  const slider = (label, min, max, step, value, onChange) => {
    const r = row(label);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'ctrl-num';
    num.min = String(min);
    num.max = String(max);
    num.step = String(step);
    num.value = String(value);
    const commit = (raw) => {
      const v = clamp(Number(raw), min, max);
      input.value = String(v);
      num.value = String(v);
      onChange(v);
    };
    input.addEventListener('input', () => commit(Number(input.value)));
    num.addEventListener('change', () => commit(num.value));
    num.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commit(num.value);
        num.blur();
      }
    });
    r.append(input, num);
  };
  const check = (label, checked, onChange) => {
    const r = row(label);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    r.append(box);
  };

  const color = document.createElement('input');
  color.type = 'color';
  color.value = st.color;
  color.addEventListener('input', () => {
    st.color = color.value;
    applyModel(currentEntry());
    scheduleSave();
  });
  row('颜色').append(color);

  slider('金属度', 0, 1, 0.01, st.metalness, (v) => { st.metalness = v; applyModel(currentEntry()); scheduleSave(); });
  slider('粗糙度', 0, 1, 0.01, st.roughness, (v) => { st.roughness = v; applyModel(currentEntry()); scheduleSave(); });
  slider('缩放 X', 0.3, 2.5, 0.02, st.sx, (v) => { st.sx = v; applyModel(currentEntry()); scheduleSave(); });
  slider('缩放 Y', 0.3, 2.5, 0.02, st.sy, (v) => { st.sy = v; applyModel(currentEntry()); scheduleSave(); });
  slider('缩放 Z', 0.3, 2.5, 0.02, st.sz, (v) => { st.sz = v; applyModel(currentEntry()); scheduleSave(); });
  if (def.kind === 'seg') {
    slider(def.segLabel, 8, 64, 1, st.seg, (v) => { st.seg = v; rebuildModel(currentEntry()); scheduleSave(); });
    if (def.id === 'cyl') {
      slider('顶面半径比', 0, 1, 0.02, st.topRatio, (v) => { st.topRatio = v; rebuildModel(currentEntry()); scheduleSave(); });
    }
  } else if (def.kind === 'detail') {
    slider('细节层级', 0, 3, 1, st.detail, (v) => { st.detail = v; rebuildModel(currentEntry()); scheduleSave(); });
    const nD = document.createElement('div');
    nD.className = 'note';
    nD.textContent = '细节层级：每一级把每个面细分为 4 个小面（总面数 ×4），数值越大棱角越多、越接近球体；0 为原始多面体。';
    wrap.append(nD);
  } else {
    const n = document.createElement('div');
    n.className = 'note';
    n.textContent = '该模型为规则立方体，可通过「缩放 X / Y / Z」调整长宽高比例。';
    wrap.append(n);
  }
  /* 锉边：把硬棱磨成很窄的斜面（拖动时按帧合并重建，避免卡顿） */
  let bevelRaf = 0;
  const rebuildSoon = (entry) => {
    if (bevelRaf) return;
    bevelRaf = requestAnimationFrame(() => {
      bevelRaf = 0;
      rebuildModel(entry);
    });
  };
  slider('锉边宽度', 0, 0.2, 0.002, st.bevel, (v) => {
    st.bevel = v;
    rebuildSoon(currentEntry());
    scheduleSave();
  });
  const nBevel = document.createElement('div');
  nBevel.className = 'note';
  nBevel.textContent = '锉边：把硬棱（相邻面夹角 ≥ 25°）磨成一条很窄的斜面，像用锉刀锉过一样，棱上的高光与明暗过渡会变得清晰可见；0 为关闭。平滑面（球面、圆柱侧面等）不受影响。';
  wrap.append(nBevel);

  slider('绕X轴旋转(°)', 0, 360, 1, st.rx, (v) => { st.rx = v; applyModel(currentEntry()); scheduleSave(); });
  slider('绕Y轴旋转(°)', 0, 360, 1, st.ry, (v) => { st.ry = v; applyModel(currentEntry()); scheduleSave(); });
  slider('绕Z轴旋转(°)', 0, 360, 1, st.rz, (v) => { st.rz = v; applyModel(currentEntry()); scheduleSave(); });
  const orientRow = document.createElement('div');
  orientRow.className = 'mode-row';
  const btnResetOrient = document.createElement('button');
  btnResetOrient.className = 'mode-btn';
  btnResetOrient.textContent = '重置朝向';
  btnResetOrient.addEventListener('click', () => {
    const d = defaultModelState(def);
    st.rx = d.rx; st.ry = d.ry; st.rz = d.rz;
    applyModel(currentEntry());
    buildModelParams();
    scheduleSave();
  });
  const btnSnap = document.createElement('button');
  btnSnap.className = 'mode-btn' + (faceSnapMode ? ' on' : '');
  btnSnap.textContent = '吸附面朝地：' + (faceSnapMode ? '开' : '关');
  btnSnap.addEventListener('click', () => {
    faceSnapMode = !faceSnapMode;
    showToast(faceSnapMode ? '已开启「吸附面朝地」：点击模型表面，该面将转至水平并朝向地面' : '已关闭「吸附面朝地」');
    buildModelParams();
    scheduleSave();
  });
  orientRow.append(btnResetOrient, btnSnap);
  wrap.append(orientRow);
  const n2 = document.createElement('div');
  n2.className = 'note';
  n2.textContent = '「吸附面朝地」：开启后点击模型表面，被点击的面会转到水平并朝向地面（模型骑坐在该面上）。';
  wrap.append(n2);
  check('显示边线', st.edges, (v) => { st.edges = v; applyModel(currentEntry()); scheduleSave(); });
  check('线框显示', st.wire, (v) => { st.wire = v; applyModel(currentEntry()); scheduleSave(); });
  slider('自转速度', 0, 1.2, 0.01, st.spin, (v) => { st.spin = v; scheduleSave(); });
  const resetRow = document.createElement('div');
  resetRow.className = 'mode-row';
  const btnResetModel = document.createElement('button');
  btnResetModel.className = 'mode-btn';
  btnResetModel.textContent = '重置模型参数';
  btnResetModel.addEventListener('click', () => {
    const keep = { rx: st.rx, ry: st.ry, rz: st.rz };
    Object.assign(st, defaultModelState(def), keep);
    rebuildModel(currentEntry());
    buildModelParams();
    scheduleSave();
    showToast('已重置「' + def.name + '」的模型参数（朝向保持不变）');
  });
  resetRow.append(btnResetModel);
  wrap.append(resetRow);
}

/* ------------------------------ 灯光 UI ------------------------------ */
function refreshSwatch(card, i) {
  const def = lightDefs[i];
  const sw = card.querySelector('.light-swatch');
  if (sw) sw.style.background = def.custom ? def.customColor : kelvinToHex(def.kelvin);
}

function renderLightUI() {
  const list = $('#light-list');
  list.innerHTML = '';
  for (let i = 0; i < MAX_LIGHTS; i++) {
    const def = lightDefs[i];
    const card = document.createElement('div');
    card.className = 'light-card' + (i < lightCount ? '' : ' hidden');
    card.innerHTML = `
      <div class="light-head">
        <span class="light-name">光源 ${i + 1}</span>
        <select class="light-type">
          <option value="directional"${def.type === 'directional' ? ' selected' : ''}>平行光</option>
          <option value="point"${def.type === 'point' ? ' selected' : ''}>点光源</option>
          <option value="spot"${def.type === 'spot' ? ' selected' : ''}>聚光灯</option>
        </select>
        <label class="mini-toggle"><input type="checkbox" class="light-enabled"${def.enabled ? ' checked' : ''}>启用</label>
        <span class="swatch light-swatch"></span>
      </div>
      <div class="mode-row">
        <button class="mode-btn${def.custom ? '' : ' on'}" data-mode="kelvin">色温模式</button>
        <button class="mode-btn${def.custom ? ' on' : ''}" data-mode="custom">自定义颜色</button>
        <input type="color" class="light-color" value="${def.customColor}"${def.custom ? '' : ' hidden'}>
      </div>
      <div class="ctrl-row kelvin-only${def.custom ? ' hidden' : ''}">
        <span class="ctrl-label">色温(K)</span>
        <input type="range" class="light-kelvin" min="1000" max="12000" step="50" value="${def.kelvin}">
        <input type="number" class="ctrl-num light-kelvin-num" min="1000" max="12000" step="50" value="${def.kelvin}">
      </div>
      <div class="ctrl-row">
        <span class="ctrl-label">强度</span>
        <input type="range" class="light-intensity" min="0" max="${TYPE_MAX[def.type]}" step="0.05" value="${def.intensity}">
        <input type="number" class="ctrl-num light-intensity-num" min="0" max="${TYPE_MAX[def.type]}" step="0.05" value="${def.intensity}">
      </div>
      <div class="ctrl-row">
        <span class="ctrl-label">方位角(°)</span>
        <input type="range" class="light-azimuth" min="0" max="360" step="1" value="${def.azimuth}">
        <input type="number" class="ctrl-num light-azimuth-num" min="0" max="360" step="1" value="${def.azimuth}">
      </div>
      <div class="ctrl-row">
        <span class="ctrl-label">仰角(°)</span>
        <input type="range" class="light-elevation" min="-90" max="90" step="1" value="${def.elevation}">
        <input type="number" class="ctrl-num light-elevation-num" min="-90" max="90" step="1" value="${def.elevation}">
      </div>
      <div class="ctrl-row">
        <span class="ctrl-label">距离</span>
        <input type="range" class="light-distance" min="2" max="15" step="0.1" value="${def.distance}">
        <input type="number" class="ctrl-num light-distance-num" min="2" max="15" step="0.1" value="${def.distance}">
      </div>
      <div class="ctrl-row spot-only${def.type === 'spot' ? '' : ' hidden'}">
        <span class="ctrl-label">锥角(°)</span>
        <input type="range" class="light-angle" min="10" max="70" step="1" value="${def.angle}">
        <input type="number" class="ctrl-num light-angle-num" min="10" max="70" step="1" value="${def.angle}">
      </div>
      <div class="ctrl-row spot-only${def.type === 'spot' ? '' : ' hidden'}">
        <span class="ctrl-label">羽化</span>
        <input type="range" class="light-penumbra" min="0" max="1" step="0.02" value="${def.penumbra}">
        <input type="number" class="ctrl-num light-penumbra-num" min="0" max="1" step="0.02" value="${def.penumbra}">
      </div>
      <label class="shadow-row"><input type="checkbox" class="light-shadow"${def.shadow ? ' checked' : ''}>投射阴影</label>
    `;
    const q = (s) => card.querySelector(s);
    q('.light-type').addEventListener('change', (e) => {
      def.type = e.target.value;
      swapLightObject(i);
      updateLight(i);
      renderLightUI();
      scheduleSave();
    });
    q('.light-enabled').addEventListener('change', (e) => {
      def.enabled = e.target.checked;
      updateLight(i);
      refreshMarkers();
      scheduleSave();
    });
    card.querySelectorAll('.mode-btn').forEach((btn) =>
      btn.addEventListener('click', () => {
        def.custom = btn.dataset.mode === 'custom';
        updateLight(i);
        renderLightUI();
        scheduleSave();
      })
    );
    q('.light-color').addEventListener('input', (e) => {
      def.customColor = e.target.value;
      updateLight(i);
      refreshSwatch(card, i);
      scheduleSave();
    });
    q('.light-kelvin').addEventListener('input', () => refreshSwatch(card, i));
    const bindRange = (cls, key) => {
      const el = q(cls);
      const num = q(cls + '-num');
      const commit = (raw) => {
        const v = clamp(Number(raw), Number(el.min), Number(el.max));
        def[key] = v;
        el.value = String(v);
        num.value = String(v);
        updateLight(i);
        scheduleSave();
      };
      el.addEventListener('input', () => commit(Number(el.value)));
      num.addEventListener('change', () => commit(num.value));
      num.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          commit(num.value);
          num.blur();
        }
      });
    };
    bindRange('.light-kelvin', 'kelvin');
    bindRange('.light-intensity', 'intensity');
    bindRange('.light-azimuth', 'azimuth');
    bindRange('.light-elevation', 'elevation');
    bindRange('.light-distance', 'distance');
    bindRange('.light-angle', 'angle');
    bindRange('.light-penumbra', 'penumbra');
    q('.light-shadow').addEventListener('change', (e) => {
      def.shadow = e.target.checked;
      updateLight(i);
      scheduleSave();
    });
    list.append(card);
    refreshSwatch(card, i);
  }
}

/* ------------------------------ 全局 UI ------------------------------ */
const setChip = (btn, on) => btn.classList.toggle('on', on);

function syncGlobalUI() {
  const setNum = (sel, v) => {
    const el = $(sel);
    if (el) el.value = v;
  };
  $('#light-count').value = lightCount;
  setNum('#light-count-num', lightCount);
  $('#ambient-intensity').value = ambientI;
  setNum('#ambient-intensity-num', ambientI);
  $('#ambient-kelvin').value = ambientK;
  setNum('#ambient-kelvin-num', ambientK);
  $('#ambient-swatch').style.background = kelvinToHex(ambientK);
  $('#hemi-toggle').checked = hemiOn;
  $('#hemi-intensity').value = hemiI;
  setNum('#hemi-intensity-num', hemiI);
  $('#exposure').value = exposure;
  setNum('#exposure-num', exposure);
  const envEl = $('#env-intensity');
  if (envEl) {
    envEl.value = envI;
    setNum('#env-intensity-num', envI);
  }
  $('#bg-select').value = bg;
  viewport.classList.remove('bg-studio', 'bg-day', 'bg-dusk', 'bg-night');
  viewport.classList.add('bg-' + bg);
  setChip($('#btn-autorotate'), autorotate);
  setChip($('#btn-markers'), showMarkers);
  setChip($('#btn-grid'), showGrid);
  setChip($('#btn-add-mode'), addMode);
  setChip($('#btn-replace-mode'), !addMode);
}

/* 提示气泡 */
let toastTimer = 0;
function showToast(text) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* 全局错误提示条：启动/运行报错时直接显示在页面上，便于定位问题 */
function showFatal(msg) {
  try {
    let el = document.getElementById('err-bar');
    if (!el) {
      el = document.createElement('div');
      el.id = 'err-bar';
      document.body.append(el);
    }
    el.textContent = '⚠ ' + msg;
    el.style.display = 'block';
  } catch {}
}
window.addEventListener('error', (e) => showFatal('脚本错误：' + (e.message || 'unknown')));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  showFatal('异步错误：' + ((r && r.message) || String(r)));
});

/* 启动兜底：无论配置加载结果如何，都保证模型与灯光面板完整渲染 */
function ensureUI() {
  try {
    if (!MODEL_DEFS.some((d) => d.id === selectedId)) selectedId = 'box';
    if (!shownIds.size || ![...shownIds].some((id) => MODEL_DEFS.some((d) => d.id === id))) {
      shownIds = new Set(['box']);
    }
    if (!shownIds.has(selectedId)) selectedId = [...shownIds][0];
    reconcileLightObjects();
    applyVisibility();
    layoutModels();
    refreshModelButtons();
    updateSelectionRing();
    buildModelParams();
    updateGlobalLights();
    updateAllLights();
    renderLightUI();
    refreshMarkers();
    syncGlobalUI();
    try {
      refreshEnvironment(); // 首帧就要有环境反射，避免金属一闪而黑
    } catch (err) {
      console.warn('环境贴图初始化失败', err);
    }
  } catch (err) {
    showFatal('界面初始化异常：' + (err && err.message ? err.message : err));
  }
}

function wireGlobalUI() {
  /* 滑杆 + 数字输入框联动 */
  const wireRow = (rangeSel, numSel, commit) => {
    const range = $(rangeSel);
    const num = $(numSel);
    const onCommit = (v) => {
      commit(v);
      range.value = String(v);
      num.value = String(v);
    };
    range.addEventListener('input', () => onCommit(Number(range.value)));
    num.addEventListener('change', () => onCommit(clamp(Number(num.value), Number(range.min), Number(range.max))));
    num.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') num.blur();
    });
  };
  wireRow('#light-count', '#light-count-num', (v) => {
    lightCount = Math.round(v);
    updateAllLights();
    refreshMarkers();
    renderLightUI();
    scheduleSave();
  });
  wireRow('#ambient-intensity', '#ambient-intensity-num', (v) => {
    ambientI = v;
    updateGlobalLights();
    scheduleSave();
  });
  wireRow('#ambient-kelvin', '#ambient-kelvin-num', (v) => {
    ambientK = Math.round(v);
    $('#ambient-swatch').style.background = kelvinToHex(ambientK);
    updateGlobalLights();
    scheduleSave();
  });
  $('#hemi-toggle').addEventListener('change', (e) => {
    hemiOn = e.target.checked;
    updateGlobalLights();
    scheduleSave();
  });
  wireRow('#hemi-intensity', '#hemi-intensity-num', (v) => {
    hemiI = v;
    updateGlobalLights();
    scheduleSave();
  });
  wireRow('#exposure', '#exposure-num', (v) => {
    exposure = v;
    renderer.toneMappingExposure = exposure;
    scheduleSave();
  });
  if ($('#env-intensity')) {
    wireRow('#env-intensity', '#env-intensity-num', (v) => {
      envI = v;
      applyEnvIntensity();
      scheduleSave();
    });
  }
  $('#bg-select').addEventListener('change', (e) => {
    bg = e.target.value;
    updateGlobalLights();
    scheduleSave();
  });
  $('#preset-select').addEventListener('change', (e) => applyPreset(Number(e.target.value)));
  $('#btn-save-default').addEventListener('click', () => {
    try {
      localStorage.setItem(DEFAULT_KEY, JSON.stringify(serializeState()));
      showToast('已保存当前配置为默认配置，下次启动将自动加载');
    } catch {
      showToast('保存失败：浏览器存储不可用');
    }
  });
  $('#btn-save-view').addEventListener('click', () => {
    const list = loadCustomViews();
    const name = nextViewName();
    list.push({ name, ...currentView() });
    saveCustomViews(list);
    renderCustomViews();
    showToast('已保存「' + name + '」，点名称应用、✎ 重命名、× 删除');
  });
  controls.addEventListener('change', syncViewInputs);
  const syncModeButtons = () => {
    setChip($('#btn-add-mode'), addMode);
    setChip($('#btn-replace-mode'), !addMode);
    refreshModelButtons();
  };
  $('#btn-add-mode').addEventListener('click', () => {
    addMode = true;
    syncModeButtons();
    scheduleSave();
  });
  $('#btn-replace-mode').addEventListener('click', () => {
    addMode = false;
    syncModeButtons();
    scheduleSave();
  });
  $('#btn-autorotate').addEventListener('click', (e) => {
    autorotate = !autorotate;
    controls.autoRotate = autorotate;
    setChip(e.currentTarget, autorotate);
    scheduleSave();
  });
  $('#btn-markers').addEventListener('click', (e) => {
    showMarkers = !showMarkers;
    setChip(e.currentTarget, showMarkers);
    refreshMarkers();
    scheduleSave();
  });
  $('#btn-grid').addEventListener('click', (e) => {
    showGrid = !showGrid;
    grid.visible = showGrid;
    setChip(e.currentTarget, showGrid);
    markEnvDirty();
    scheduleSave();
  });
  $('#btn-shot').addEventListener('click', () => {
    renderer.render(scene, camera);
    const v = currentView();
    const bgNames = { studio: '暗色影棚', day: '明亮天空', dusk: '黄昏渐变', night: '深夜' };
    const bgName = bgNames[bg] ?? bg;
    const typeNames = { directional: '平行光', point: '点光源', spot: '聚光灯' };
    const lightsTxt = lightDefs
      .slice(0, lightCount)
      .filter((d) => d.enabled)
      .map((d) => typeNames[d.type] + ' ' + fmt(d.intensity) + '/' + (d.custom ? d.customColor : Math.round(d.kelvin) + 'K'))
      .join('，');
    const modelTxt = [...shownIds]
      .map((id) => (MODEL_DEFS.find((d) => d.id === id) ?? {}).name)
      .filter(Boolean)
      .join('/');
    const lines = [
      '光影实验室 · Light Studio',
      '视角：方位角 ' + Math.round(v.az) + '° · 仰角 ' + Math.round(v.el) + '° · 距离 ' + v.d.toFixed(1),
      '光照(' + lightCount + ')：' + (lightsTxt || '无'),
      '环境光 ' + fmt(ambientI) + ' · 曝光 ' + fmt(exposure) + ' · 背景 ' + bgName,
      '模型：' + (modelTxt || '无'),
      '保存时间：' + new Date().toLocaleString(),
    ];
    /* 把参数信息叠加绘制到截图左上角 */
    const c2 = document.createElement('canvas');
    c2.width = canvas.width;
    c2.height = canvas.height;
    const ctx = c2.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const fs = Math.max(13, Math.round(c2.height / 60));
    ctx.font = fs + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
    const lineH = fs * 1.6;
    const pad = fs;
    const wMax = Math.max(...lines.map((t) => ctx.measureText(t).width));
    const bw = wMax + pad * 2;
    const bh = lines.length * lineH + pad * 1.3;
    ctx.fillStyle = 'rgba(10, 14, 22, 0.72)';
    roundRectPath(ctx, pad, pad, bw, bh, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(91, 195, 255, 0.85)';
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, pad, pad, bw, bh, 10);
    ctx.stroke();
    ctx.fillStyle = '#dff0ff';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    lines.forEach((t, i) => ctx.fillText(t, pad * 2, pad * 1.15 + i * lineH));
    /* 文件名携带视角与光照参数 */
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const ts = now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate()) + '-' + p2(now.getHours()) + p2(now.getMinutes()) + p2(now.getSeconds());
    const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_');
    const fname =
      safe('light-studio_AZ' + Math.round(v.az) + '_EL' + Math.round(v.el) + '_D' + v.d.toFixed(1) + '_L' + lightCount + '_' + bgName) + '_' + ts + '.png';
    c2.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    }, 'image/png');
  });
  $('#btn-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  });
  $('#btn-reset').addEventListener('click', () => {
    if (!window.confirm('确定要重置吗？将恢复为已保存的默认配置（若未保存过默认配置，则恢复出厂预设）。')) return;
    let done = false;
    try {
      const d = JSON.parse(localStorage.getItem(DEFAULT_KEY));
      if (d && typeof d === 'object') {
        loadState(d);
        done = true;
      }
    } catch {}
    if (!done) {
      try { localStorage.removeItem(SAVE_KEY); } catch {}
      MODEL_DEFS.forEach((d) => (modelState[d.id] = defaultModelState(d)));
      modelEntries.forEach((e) => {
        e.state = modelState[e.def.id];
        rebuildModel(e);
      });
      shownIds = new Set(['box']);
      faceSnapMode = false;
      addMode = true;
      applyPreset(0);
      selectModel('box');
    }
    controls.reset();
  });
}

/* ---------------------------- 持久化 ---------------------------- */
const SAVE_KEY = 'light-studio-v5';
const DEFAULT_KEY = 'light-studio-default-v5';

function serializeState() {
  return {
    lightCount,
    defs: lightDefs,
    ambientI,
    ambientK,
    hemiOn,
    hemiI,
    exposure,
    envI,
    bg,
    selectedId,
    shownIds: [...shownIds],
    faceSnapMode,
    addMode,
    modelState,
    autorotate,
    showMarkers,
    showGrid,
  };
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(serializeState()));
    } catch {}
  }, 400);
}

function loadState(s) {
  if (!s || typeof s !== 'object') return false;
  lightCount = clamp(Math.round(s.lightCount ?? 1), 1, MAX_LIGHTS);
  (s.defs ?? []).forEach((d, i) => {
    if (i < MAX_LIGHTS) {
      lightDefs[i] = { ...defaultLightDefs()[i], ...d };
      const tMax = TYPE_MAX[lightDefs[i].type] ?? 10;
      lightDefs[i].intensity = clamp(Number(lightDefs[i].intensity) || 0, 0, tMax);
    }
  });
  reconcileLightObjects();
  ambientI = s.ambientI ?? 0.5;
  ambientK = s.ambientK ?? 6500;
  hemiOn = !!s.hemiOn;
  hemiI = s.hemiI ?? 0.4;
  exposure = s.exposure ?? 1;
  envI = clamp(Number(s.envI ?? 0.7) || 0, 0, 3);
  bg = s.bg ?? 'studio';
  autorotate = !!s.autorotate;
  showMarkers = s.showMarkers !== false;
  showGrid = s.showGrid !== false;
  if (s.modelState) {
    Object.keys(s.modelState).forEach((id) => {
      if (modelState[id]) {
        const def = MODEL_DEFS.find((d) => d.id === id);
        const ms = { ...defaultModelState(def), ...s.modelState[id] };
        for (const k of ['sx', 'sy', 'sz']) ms[k] = clamp(Number(ms[k]) || 1, 0.3, 2.5);
        ms.rx = normDeg(Number(ms.rx) || 0);
        ms.ry = normDeg(Number(ms.ry) || 0);
        ms.rz = normDeg(Number(ms.rz) || 0);
        ms.seg = clamp(Math.round(Number(ms.seg) || 32), 8, 64);
        ms.detail = clamp(Math.round(Number(ms.detail) || 0), 0, 3);
        ms.bevel = clamp(Number(ms.bevel) || 0, 0, 0.2);
        modelState[id] = ms;
      }
    });
  }
  selectedId = MODEL_DEFS.some((d) => d.id === s.selectedId) ? s.selectedId : 'box';
  if (Array.isArray(s.shownIds) && s.shownIds.length) {
    const valid = s.shownIds.filter((id) => MODEL_DEFS.some((d) => d.id === id));
    if (valid.length) shownIds = new Set(valid);
  }
  faceSnapMode = !!s.faceSnapMode;
  addMode = s.addMode !== false;
  controls.autoRotate = autorotate;
  grid.visible = showGrid;
  syncGlobalUI();
  updateGlobalLights();
  updateAllLights();
  renderLightUI();
  refreshMarkers();
  modelEntries.forEach((e) => {
    e.state = modelState[e.def.id];
    rebuildModel(e);
  });
  selectModel(selectedId);
  return true;
}

function loadSaved() {
  let s;
  try {
    s = JSON.parse(localStorage.getItem(SAVE_KEY));
  } catch {}
  return loadState(s);
}

/* ---------------------------- 交互拾取 ---------------------------- */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const visibleMeshes = () => modelEntries.filter((e) => e.group.visible).map((e) => e.mesh);

function pickAt(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(visibleMeshes(), false)[0];
  if (!hit) return null;
  return { entry: modelEntries.find((e) => e.mesh === hit.object), hit };
}

const normDeg = (d) => ((Math.round(d) % 360) + 360) % 360;

/* 将点击到的面转到水平并朝向地面（面法线对齐世界 -Y） */
function snapFaceUp(entry, hit) {
  const m = entry.mesh;
  m.updateMatrix();
  const normal = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(m.matrix)).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(normal, DOWN);
  m.quaternion.premultiply(q);
  const st = entry.state;
  const e = new THREE.Euler().setFromQuaternion(m.quaternion, 'XYZ');
  st.rx = normDeg((e.x * 180) / Math.PI);
  st.ry = normDeg((e.y * 180) / Math.PI);
  st.rz = normDeg((e.z * 180) / Math.PI);
  applyModel(entry);
  buildModelParams();
  scheduleSave();
}

let downAt = null;
canvas.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
canvas.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 6) return;
  const res = pickAt(e.clientX, e.clientY);
  if (!res) return;
  if (res.entry.def.id !== selectedId) {
    selectModel(res.entry.def.id);
    if (!faceSnapMode) return;
  }
  if (faceSnapMode && res.hit.face) snapFaceUp(res.entry, res.hit);
});
canvas.addEventListener('pointermove', (e) => {
  canvas.style.cursor = pickAt(e.clientX, e.clientY) ? 'pointer' : 'grab';
});

/* ---------------------------- 视角控制 ---------------------------- */
const VIEW_PRESETS = [
  { name: '默认', az: 0, el: 15, d: 16, isDefault: true },
  { name: '正面', az: 0, el: 15, d: 14 },
  { name: '侧面', az: 90, el: 15, d: 14 },
  { name: '45°角', az: 45, el: 22, d: 14 },
  { name: '低角度', az: 35, el: 6, d: 12 },
  { name: '俯视', az: 0, el: 85, d: 14 },
];
const VIEWS_KEY = 'light-studio-views-v1';
const viewRowRefs = [];

/* 当前相机视角 → 方位角 / 仰角 / 距离 */
function currentView() {
  const offset = camera.position.clone().sub(controls.target);
  const d = offset.length();
  if (!isFinite(d) || d <= 0.01) return { az: 0, el: 15, d: 16 };
  const el = (Math.asin(clamp(offset.y / d, -1, 1)) * 180) / Math.PI;
  const az = normDeg((Math.atan2(offset.x, offset.z) * 180) / Math.PI);
  return { az, el, d };
}

/* 按方位角/仰角/距离摆放相机（绕目标点） */
function applyView(az, el, d) {
  if (!isFinite(az) || !isFinite(el) || !isFinite(d)) return;
  const azR = deg2rad(az);
  const elR = deg2rad(clamp(el, 0, 87));
  const dist = clamp(d, controls.minDistance, controls.maxDistance);
  const off = new THREE.Vector3(
    dist * Math.cos(elR) * Math.sin(azR),
    dist * Math.sin(elR),
    dist * Math.cos(elR) * Math.cos(azR)
  );
  camera.position.copy(controls.target).add(off);
  controls.update();
  syncViewInputs();
}

/* 用当前相机位置刷新视角输入框（仅当正在编辑输入框时不覆盖，点击按钮等操作正常同步） */
function syncViewInputs() {
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
  const v = currentView();
  for (const row of viewRowRefs) {
    const val = String(Math.round(v[row.key] * 10) / 10);
    row.range.value = val;
    row.num.value = val;
  }
}

function loadCustomViews() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEWS_KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveCustomViews(list) {
  try {
    localStorage.setItem(VIEWS_KEY, JSON.stringify(list));
  } catch {}
}

/* 生成不重复的默认视角名：视角 1、视角 2、… */
function nextViewName() {
  let maxN = 0;
  loadCustomViews().forEach((v) => {
    const m = String(v.name).match(/(\d+)/);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  });
  return '视角 ' + (maxN + 1);
}

function renderCustomViews() {
  const wrap = $('#custom-views');
  wrap.innerHTML = '';
  const views = loadCustomViews();
  if (!views.length) {
    const n = document.createElement('div');
    n.className = 'note';
    n.textContent = '暂无自定义视角：调整视角后点「保存视角」即可收藏。';
    wrap.append(n);
    return;
  }
  views.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'view-item';
    const b = document.createElement('button');
    b.className = 'mode-btn view-btn';
    b.textContent = v.name;
    b.title = '点击应用该视角';
    b.addEventListener('click', () => applyView(v.az ?? 0, v.el ?? 15, v.d ?? 14));
    const re = document.createElement('button');
    re.className = 'mode-btn rename-btn';
    re.textContent = '✎';
    re.title = '重命名';
    re.addEventListener('click', () => startViewRename(row, b, i));
    const del = document.createElement('button');
    del.className = 'view-del';
    del.textContent = '×';
    del.title = '删除该视角';
    del.addEventListener('click', () => {
      const list = loadCustomViews();
      list.splice(i, 1);
      saveCustomViews(list);
      renderCustomViews();
    });
    row.append(b, re, del);
    wrap.append(row);
  });
}

/* 内联重命名：把名称按钮替换成输入框，回车/失焦确认，Esc 取消 */
function startViewRename(row, nameBtn, i) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = nameBtn.textContent;
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const list = loadCustomViews();
      const newName = input.value.trim();
      if (newName && list[i]) {
        list[i].name = newName;
        saveCustomViews(list);
      }
    }
    renderCustomViews();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  row.replaceChild(input, nameBtn);
  input.focus();
  input.select();
}

function buildViewUI() {
  const wrap = $('#view-rows');
  wrap.innerHTML = '';
  viewRowRefs.length = 0;
  const rows = [
    { key: 'az', label: '方位角(°)', min: 0, max: 360, step: 1 },
    { key: 'el', label: '仰角(°)', min: 0, max: 87, step: 1 },
    { key: 'd', label: '距离', min: 4, max: 40, step: 0.5 },
  ];
  for (const r of rows) {
    const cell = document.createElement('div');
    cell.className = 'view-cell';
    const lab = document.createElement('span');
    lab.className = 'cell-label';
    lab.textContent = r.label;
    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'cell-controls';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(r.min);
    range.max = String(r.max);
    range.step = String(r.step);
    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'ctrl-num';
    num.min = String(r.min);
    num.max = String(r.max);
    num.step = String(r.step);
    const commit = (raw) => {
      const v = clamp(Number(raw), r.min, r.max);
      const cur = currentView();
      cur[r.key] = v;
      applyView(cur.az, cur.el, cur.d);
    };
    /* 拖动滑杆时只实时预览数值，松手(change)才移动相机，避免输入与相机同步互相打架 */
    range.addEventListener('input', () => {
      num.value = range.value;
    });
    range.addEventListener('change', () => commit(range.value));
    num.addEventListener('change', () => commit(num.value));
    num.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commit(num.value);
        num.blur();
      }
    });
    controlsDiv.append(range, num);
    cell.append(lab, controlsDiv);
    wrap.append(cell);
    viewRowRefs.push({ key: r.key, range, num });
  }
  const pw = $('#view-presets');
  pw.innerHTML = '';
  VIEW_PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'mode-btn';
    b.textContent = p.name;
    b.addEventListener('click', () => {
      if (p.isDefault) controls.reset();
      else applyView(p.az, p.el, p.d);
    });
    pw.append(b);
  });
  syncViewInputs();
}

/* ---------------------------- 动画循环 ---------------------------- */
const clock = new THREE.Clock();
let fpsFrames = 0;
let fpsTime = 0;
let envLast = -1; // 上次环境贴图刷新时刻（秒）

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  for (const e of modelEntries) {
    if (e.group.visible) e.group.rotation.y += e.state.spin * dt;
  }
  markers.forEach((m, i) => m.sphere.scale.setScalar(1 + Math.sin(t * 3 + i * 1.7) * 0.18));
  controls.update();
  /* 环境贴图按需重算（限频，避免拖动参数时每帧都捕捉一遍场景） */
  if (envDirty && t - envLast >= ENV_INTERVAL) {
    envDirty = false;
    envLast = t;
    refreshEnvironment();
  }
  renderer.render(scene, camera);
  fpsFrames += 1;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    $('#fps').textContent = Math.round(fpsFrames / fpsTime) + ' FPS';
    fpsFrames = 0;
    fpsTime = 0;
  }
}

/* ------------------------------ 启动 ------------------------------ */
buildModelButtons();
PRESETS.forEach((p, i) => {
  const opt = document.createElement('option');
  opt.value = String(i);
  opt.textContent = p.name;
  $('#preset-select').append(opt);
});
wireGlobalUI();
try {
  buildViewUI();
  renderCustomViews();
} catch (err) {
  console.error('视角面板初始化失败（不影响场景渲染）', err);
}
let loaded = false;
try {
  const d = JSON.parse(localStorage.getItem(DEFAULT_KEY));
  if (d) loaded = loadState(d);
} catch {}
if (!loaded) {
  try {
    loaded = loadSaved();
  } catch (err) {
    showFatal('配置加载失败：' + (err && err.message ? err.message : err));
  }
}
if (!loaded) {
  try {
    applyPreset(0);
  } catch {}
}
ensureUI();
requestAnimationFrame(animate);
