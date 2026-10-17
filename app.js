import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

const viewerModeSelect = document.getElementById("viewer-mode");
const experimentLabel = document.getElementById("experiment-label");
const experimentSelect = document.getElementById("experiment");
const layoutLabel = document.getElementById("layout-label");
const modeSelect = document.getElementById("mode");
const leftSelect = document.getElementById("left-method");
const tcSelect = document.getElementById("tc-method");
const rightSelect = document.getElementById("right-method");
const blSelect = document.getElementById("bl-method");
const bcSelect = document.getElementById("bc-method");
const brSelect = document.getElementById("br-method");
const leftLabel = document.getElementById("left-label");
const tcLabel = document.getElementById("tc-label");
const rightLabel = document.getElementById("right-label");
const blLabel = document.getElementById("bl-label");
const bcLabel = document.getElementById("bc-label");
const brLabel = document.getElementById("br-label");
const loadPlyInput = document.getElementById("load-ply-input");
const resetBtn = document.getElementById("reset-cam");
const settingsBtn = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings-panel");
const settingsClose = document.getElementById("settings-close");
const settingsReset = document.getElementById("settings-reset");
const hintEl = document.querySelector("#toolbar .hint");
const stagesEl = document.getElementById("stages");
const stageLeft = document.getElementById("stage-left");
const stageTc = document.getElementById("stage-tc");
const stageRight = document.getElementById("stage-right");
const stageBl = document.getElementById("stage-bl");
const stageBc = document.getElementById("stage-bc");
const stageBr = document.getElementById("stage-br");

const SETTINGS_KEY = "gs-compare-controls-v3";
const DEFAULT_SETTINGS = {
  lookSensitivity: 0.002,
  moveScale: 1.0,
  boostMultiplier: 3.5,
  fineMultiplier: 0.2,
  rollSpeed: 1.8,
  fineLookMultiplier: 0.35,
};

/** @type {typeof DEFAULT_SETTINGS} */
let settings = loadSettings();

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/**
 * @typedef {{ transform: number[][], scale: number }} DataparserTransform
 * @typedef {{ id: string, label: string, url?: string, fileBytes?: ArrayBuffer|Uint8Array, fileName?: string, num_gaussians?: number|null, psnr?: number|null, ssim?: number|null, lpips?: number|null, peak_vram_mib?: number|null, notes?: string|null, up_axis?: "opencv"|"z"|"y"|null, dataparser?: DataparserTransform|null, experiment?: string|null }} Method
 * @typedef {{ id: string, label: string, methodIds: string[] }} Experiment
 */
/** @type {Method[]} */
let methods = [];
let methodById = new Map();
/** @type {Experiment[]} */
let experiments = [];
let experimentById = new Map();
/** @type {"custom"|"experiment"} */
let viewerMode = "custom";
/** @type {string|null} */
let activeExperimentId = null;

/**
 * @typedef {"opencv"|"z"|"y"} UpAxis
 * @typedef {object} Panel
 * @property {HTMLElement} stage
 * @property {HTMLElement} overlay
 * @property {THREE.Scene} scene
 * @property {SparkRenderer} spark
 * @property {SplatMesh|null} splat
 * @property {string|null} methodId
 * @property {AbortController|null} loadAbort
 * @property {number|null} extent
 * @property {UpAxis|null} upAxis
 * @property {DataparserTransform|null} dataparser
 */

/** @type {Panel} */
let left;
/** @type {Panel} */
let tc;
/** @type {Panel} */
let right;
/** @type {Panel} */
let bl;
/** @type {Panel} */
let bc;
/** @type {Panel} */
let br;
/** @type {"single"|"dual"|"triple"|"quad"|"hex"} */
let layout = "dual";

/** One GL context + one camera — scissor each panel. Guarantees pose sync. */
/** @type {THREE.WebGLRenderer} */
let sharedRenderer;
/** @type {THREE.PerspectiveCamera} */
let sharedCamera;
/** @type {FreeCam|null} */
let freecam = null;

/**
 * Canonical viewing size after alignment.
 *
 * All panels share TL’s COLMAP frame after orientation:
 * - Official CUDA PLYs: OpenCV → Y-up (180° X)
 * - Nerfstudio PLYs with `dataparser`: inverse NS transform → COLMAP, then same 180° X
 * - Bare Z-up (no dataparser): −90° X only (own-fit fallback)
 */
const VIEW_EXTENT = 10;
/** @type {THREE.Vector3|null} */
let referenceCenter = null;
/** @type {number|null} */
let referenceNativeExtent = null;
let defaultCamPose = null;
const _sizeTmp = new THREE.Vector3();
const _matOrient = new THREE.Matrix4();
const _matTmp = new THREE.Matrix4();
const _matTmp2 = new THREE.Matrix4();
const NEAR = 0.001;
const FAR = 5000;
const HINT_FREECAM =
  "Click to fly · WASD · Space/Ctrl · RMB fine · Shift boost · Q/E roll · Tab exit";
const HINT_FREECAM_LOCKED =
  "Flying · WASD · Space/Ctrl · RMB fine · Shift boost · Q/E roll · Tab to release";

function updateHint() {
  if (!hintEl) return;
  hintEl.textContent = freecam?.isLocked ? HINT_FREECAM_LOCKED : HINT_FREECAM;
}

/**
 * Pointer-lock 6DOF freecam relative to the camera (not world axes).
 * WASD + Space/Ctrl move in view space; mouse pitches/yaws in camera space;
 * Q/E roll; hold RMB for finer move/look. Tab unlocks.
 */
class FreeCam {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} domElement
   */
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.sceneBaseSpeed = 1.0;
    this.enabled = true;
    this.isLocked = false;
    this.rmbHeld = false;
    this._keys = new Set();
    this._wishLocal = new THREE.Vector3();
    this._wishWorld = new THREE.Vector3();
    this._rollAxis = new THREE.Vector3();
    this._pitchAxis = new THREE.Vector3();
    this._yawAxis = new THREE.Vector3();
    this._qPitch = new THREE.Quaternion();
    this._qYaw = new THREE.Quaternion();
    this._qRoll = new THREE.Quaternion();

    domElement.style.cursor = "pointer";
    domElement.addEventListener("click", (e) => {
      if (!this.enabled || this.isLocked) return;
      if (e.button !== 0) return;
      domElement.requestPointerLock();
    });

    // RMB fine-control while pointer-locked (buttons bitmask / button events).
    document.addEventListener("mousedown", (e) => {
      if (e.button === 2) this.rmbHeld = true;
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 2) this.rmbHeld = false;
    });
    document.addEventListener("pointerlockchange", () => {
      this.isLocked = document.pointerLockElement === domElement;
      domElement.style.cursor = this.isLocked ? "none" : "pointer";
      updateHint();
      if (!this.isLocked) {
        this._keys.clear();
        this.rmbHeld = false;
      }
    });
    // Keep context menu from stealing RMB when flying.
    domElement.addEventListener("contextmenu", (e) => {
      if (this.isLocked) e.preventDefault();
    });

    document.addEventListener("mousemove", (event) => {
      if (!this.isLocked || !this.enabled) return;
      // buttons bit 2 = right mouse; more reliable under pointer lock than mouseup alone.
      this.rmbHeld = (event.buttons & 2) === 2;
      let sens = settings.lookSensitivity;
      if (this.rmbHeld) sens *= settings.fineLookMultiplier;
      const dx = event.movementX * sens;
      const dy = event.movementY * sens;
      this._pitchAxis.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      this._yawAxis.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      this._qPitch.setFromAxisAngle(this._pitchAxis, -dy);
      this._qYaw.setFromAxisAngle(this._yawAxis, -dx);
      this.camera.quaternion.premultiply(this._qYaw).premultiply(this._qPitch);
      this.camera.quaternion.normalize();
    });

    window.addEventListener("keydown", (e) => this._onKeyDown(e));
    window.addEventListener("keyup", (e) => this._onKeyUp(e));
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  _onKeyDown(e) {
    if (e.code === "Tab") {
      if (this.isLocked) {
        e.preventDefault();
        this.unlock();
      }
      return;
    }
    if (!this.isLocked) return;
    if (
      ["Space", "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "KeyQ", "KeyE"].includes(
        e.code,
      )
    ) {
      e.preventDefault();
    }
    this._keys.add(e.code);
  }

  _onKeyUp(e) {
    this._keys.delete(e.code);
  }

  setMoveSpeed(base) {
    this.sceneBaseSpeed = base;
  }

  /** Effective keyboard move speed from scene scale + settings + modifiers. */
  _moveSpeed() {
    let speed = this.sceneBaseSpeed * settings.moveScale;
    if (this._keys.has("ShiftLeft") || this._keys.has("ShiftRight")) {
      speed *= settings.boostMultiplier;
    }
    if (this.rmbHeld) speed *= settings.fineMultiplier;
    return speed;
  }

  /** @param {number} dt seconds */
  update(dt) {
    if (!this.enabled || !this.isLocked) return;

    const speed = this._moveSpeed();

    let roll = 0;
    if (this._keys.has("KeyQ")) roll -= settings.rollSpeed;
    if (this._keys.has("KeyE")) roll += settings.rollSpeed;
    if (roll !== 0) {
      const rollRate = this.rmbHeld ? roll * settings.fineMultiplier : roll;
      this.camera.getWorldDirection(this._rollAxis);
      this._qRoll.setFromAxisAngle(this._rollAxis, rollRate * dt);
      this.camera.quaternion.premultiply(this._qRoll).normalize();
    }

    this._wishLocal.set(0, 0, 0);
    if (this._keys.has("KeyW")) this._wishLocal.z -= 1;
    if (this._keys.has("KeyS")) this._wishLocal.z += 1;
    if (this._keys.has("KeyD")) this._wishLocal.x += 1;
    if (this._keys.has("KeyA")) this._wishLocal.x -= 1;
    if (this._keys.has("Space")) this._wishLocal.y += 1;
    if (this._keys.has("ControlLeft") || this._keys.has("ControlRight")) this._wishLocal.y -= 1;

    if (this._wishLocal.lengthSq() > 0) {
      this._wishLocal.normalize();
      this._wishWorld.copy(this._wishLocal).applyQuaternion(this.camera.quaternion);
      this.camera.position.addScaledVector(this._wishWorld, speed * dt);
    }
  }
}

function formatMetric(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Number(value).toFixed(digits);
}

function formatCount(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString();
}

function updateOverlay(panel, method, statusText, isError = false) {
  const title = panel.overlay.querySelector("h2");
  const meta = panel.overlay.querySelector(".meta");
  const status = panel.overlay.querySelector(".status");
  title.textContent = method ? method.label : "—";
  const lines = [];
  if (method) {
    lines.push(`Gaussians: ${formatCount(method.num_gaussians)}`);
    lines.push(
      `PSNR ${formatMetric(method.psnr)} · SSIM ${formatMetric(method.ssim, 3)} · LPIPS ${formatMetric(method.lpips, 3)}`,
    );
    lines.push(`Peak VRAM: ${method.peak_vram_mib != null ? `${formatMetric(method.peak_vram_mib, 0)} MiB` : "—"}`);
    if (method.notes) lines.push(method.notes);
  }
  meta.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  status.textContent = statusText || "";
  status.classList.toggle("error", Boolean(isError));
  status.style.display = statusText ? "block" : "none";
}

function createPanel(stageEl) {
  const overlay = stageEl.querySelector(".overlay");
  const scene = new THREE.Scene();
  // Transparent — the shared canvas clears to black behind the grid.
  scene.background = null;

  const spark = new SparkRenderer({
    renderer: sharedRenderer,
    minPixelRadius: 0.0,
    maxPixelRadius: 512.0,
    clipXY: 1.4,
  });
  scene.add(spark);

  return {
    stage: stageEl,
    overlay,
    scene,
    spark,
    splat: null,
    methodId: null,
    loadAbort: null,
    extent: null,
    upAxis: null,
    dataparser: null,
  };
}

function resizeSharedRenderer() {
  if (!sharedRenderer || !stagesEl) return;
  const w = stagesEl.clientWidth;
  const h = stagesEl.clientHeight;
  if (w < 1 || h < 1) return;
  sharedRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
  sharedRenderer.setSize(w, h, false);
  sharedCamera.near = NEAR;
  sharedCamera.far = FAR;
  sharedCamera.updateProjectionMatrix();
}

/** Stage rect in CSS pixels relative to #stages (WebGL Y flipped by caller). */
function stageRect(stageEl) {
  const root = stagesEl.getBoundingClientRect();
  const r = stageEl.getBoundingClientRect();
  return {
    x: r.left - root.left,
    y: r.top - root.top,
    w: r.width,
    h: r.height,
  };
}

function disposeSplat(panel) {
  if (!panel.splat) return;
  panel.scene.remove(panel.splat);
  if (typeof panel.splat.dispose === "function") {
    try {
      panel.splat.dispose();
    } catch (_) {
      /* ignore */
    }
  }
  panel.splat = null;
  panel.extent = null;
}

/**
 * Robust AABB from splat centers (percentile trim), so floaters don't explode
 * scale/alignment between methods. Spark's getBoundingBox is local-space.
 * @returns {{ box: THREE.Box3, center: THREE.Vector3, extent: number }}
 */
function getRobustBounds(splat) {
  const xs = [];
  const ys = [];
  const zs = [];

  if (splat.splats && typeof splat.splats.forEachSplat === "function") {
    const nRaw = splat.numSplats?.value ?? splat.numSplats;
    const nGuess = typeof nRaw === "number" && nRaw > 0 ? nRaw : 20000;
    const stride = Math.max(1, Math.floor(nGuess / 6000));
    splat.splats.forEachSplat((index, center) => {
      if (index % stride === 0) {
        xs.push(center.x);
        ys.push(center.y);
        zs.push(center.z);
      }
    });
  }

  let localBox;
  if (xs.length >= 30) {
    const pct = (arr, p) => {
      const a = arr.slice().sort((u, v) => u - v);
      const t = (a.length - 1) * p;
      const lo = Math.floor(t);
      const f = t - lo;
      return a[lo] * (1 - f) + a[Math.min(lo + 1, a.length - 1)] * f;
    };
    // Tighter trim than 5–95: heavy floater tails still biased MS vs NS framing.
    localBox = new THREE.Box3(
      new THREE.Vector3(pct(xs, 0.1), pct(ys, 0.1), pct(zs, 0.1)),
      new THREE.Vector3(pct(xs, 0.9), pct(ys, 0.9), pct(zs, 0.9)),
    );
  } else if (typeof splat.getBoundingBox === "function") {
    localBox = splat.getBoundingBox(true);
  } else {
    localBox = new THREE.Box3(
      new THREE.Vector3(-2, -2, -2),
      new THREE.Vector3(2, 2, 2),
    );
  }

  const box = localBox.clone().applyMatrix4(splat.matrixWorld);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  const extent = Math.max(size.x, size.y, size.z, 1e-3);
  return { box, center, extent };
}

/**
 * Object matrix: local PLY → Three.js Y-up world (before view fit).
 * NS + dataparser: p_colmap = inv(T) @ (p_ns / scale), then OpenCV 180° X.
 */
function orientationMatrix(upAxis, dataparser, out = _matOrient) {
  if (dataparser?.transform && dataparser.scale) {
    const T = dataparser.transform;
    const sc = dataparser.scale;
    _matTmp.set(
      T[0][0],
      T[0][1],
      T[0][2],
      T[0][3],
      T[1][0],
      T[1][1],
      T[1][2],
      T[1][3],
      T[2][0],
      T[2][1],
      T[2][2],
      T[2][3],
      0,
      0,
      0,
      1,
    );
    _matTmp.invert();
    _matTmp2.makeScale(1 / sc, 1 / sc, 1 / sc);
    out.multiplyMatrices(_matTmp, _matTmp2);
    // COLMAP OpenCV → Three.js Y-up
    _matTmp.makeRotationX(Math.PI);
    out.premultiply(_matTmp);
    return out;
  }
  if (upAxis === "z") {
    // Nerfstudio Z-up → Y-up (−90° X) without COLMAP lock
    return out.makeRotationX(-Math.PI / 2);
  }
  if (upAxis === "y") return out.identity();
  // Classic 3DGS / COLMAP OpenCV: Y-down → Y-up (180° X)
  return out.makeRotationX(Math.PI);
}

/** Apply orientation matrix onto a splat mesh. */
function applyOrientation(splat, upAxis, dataparser) {
  orientationMatrix(upAxis, dataparser, _matOrient).decompose(
    splat.position,
    splat.quaternion,
    splat.scale,
  );
  splat.updateMatrixWorld(true);
}

/**
 * Pick OpenCV vs Z-up by which orientation makes Y the short axis (ground plane).
 * Avoids a second PLY HTTP fetch (which aborted mid-stream and reset the server).
 * @returns {UpAxis}
 */
function detectUpAxisFromSplat(splat, hint) {
  if (hint === "opencv" || hint === "z" || hint === "y") return hint;

  /** @type {UpAxis} */
  let best = "opencv";
  let bestScore = Infinity;
  for (const axis of /** @type {UpAxis[]} */ (["opencv", "z"])) {
    applyOrientation(splat, axis, null);
    const { box } = getRobustBounds(splat);
    box.getSize(_sizeTmp);
    const score = _sizeTmp.y / Math.max(_sizeTmp.x, _sizeTmp.z, 1e-6);
    if (score < bestScore) {
      bestScore = score;
      best = axis;
    }
  }
  return best;
}

/**
 * Orient into Y-up (and COLMAP if dataparser), then place into TL’s shared frame.
 */
function alignSplatToFrame(splat, upAxis, dataparser) {
  const orient = orientationMatrix(upAxis, dataparser, _matOrient);

  if (referenceCenter != null && referenceNativeExtent != null) {
    const s = VIEW_EXTENT / Math.max(referenceNativeExtent, 1e-6);
    _matTmp2.makeScale(s, s, s);
    _matTmp.makeTranslation(
      -s * referenceCenter.x,
      -s * referenceCenter.y,
      -s * referenceCenter.z,
    );
    // M = T(-s·c) · S(s) · Orient
    _matTmp.multiply(_matTmp2).multiply(orient);
    _matTmp.decompose(splat.position, splat.quaternion, splat.scale);
  } else {
    orient.decompose(splat.position, splat.quaternion, splat.scale);
    splat.updateMatrixWorld(true);
    const own = getRobustBounds(splat);
    const s = VIEW_EXTENT / Math.max(own.extent, 1e-6);
    _matTmp2.makeScale(s, s, s);
    _matTmp.makeTranslation(-s * own.center.x, -s * own.center.y, -s * own.center.z);
    _matTmp.multiply(_matTmp2).multiply(orient);
    _matTmp.decompose(splat.position, splat.quaternion, splat.scale);
  }
  splat.updateMatrixWorld(true);
}

/** Re-apply alignment for every loaded panel. */
function realignLoadedPanels() {
  for (const panel of visiblePanels()) {
    if (!panel.splat || !panel.upAxis) continue;
    alignSplatToFrame(panel.splat, panel.upAxis, panel.dataparser);
    if (typeof panel.splat.updateVersion === "function") panel.splat.updateVersion();
  }
}

/** Panel order for each layout (TL→…→BR). */
function panelSlotsForLayout(lay) {
  if (lay === "single") return [left].filter(Boolean);
  if (lay === "dual") return [left, right].filter(Boolean);
  if (lay === "triple") return [left, tc, right].filter(Boolean);
  if (lay === "quad") return [left, right, bl, br].filter(Boolean);
  return [left, tc, right, bl, bc, br].filter(Boolean);
}

function layoutForCount(n) {
  if (n <= 1) return "single";
  if (n === 2) return "dual";
  if (n === 3) return "triple";
  if (n <= 4) return "quad";
  return "hex";
}

/** When set (experiment mode), only the first N slots of the layout are shown. */
/** @type {number|null} */
let panelLimit = null;

function visiblePanels() {
  const slots = panelSlotsForLayout(layout);
  if (panelLimit == null) return slots;
  return slots.slice(0, Math.max(0, panelLimit));
}

function setMoveSpeedForExtent(extent) {
  const base = Math.max(0.2, extent * 0.4);
  freecam?.setMoveSpeed(base);
}

function placeCameraForScene(storeAsDefault) {
  sharedCamera.near = NEAR;
  sharedCamera.far = FAR;
  sharedCamera.updateProjectionMatrix();

  const dist = Math.max(VIEW_EXTENT * 0.9, 0.5);
  sharedCamera.position.set(dist * 0.15, dist * 0.25, dist);
  sharedCamera.up.set(0, 1, 0);
  sharedCamera.lookAt(0, 0, 0);

  if (storeAsDefault) {
    defaultCamPose = {
      position: sharedCamera.position.clone(),
      quaternion: sharedCamera.quaternion.clone(),
    };
  }
}

/** Non-control panels (everything except TL/left). */
function followerPanels() {
  return visiblePanels().filter((p) => p && p !== left);
}

async function loadMethod(panel, methodId, { fitCamera = false, isReference = false } = {}) {
  const method = methodById.get(methodId);
  if (!method) {
    updateOverlay(panel, null, `Unknown method: ${methodId}`, true);
    return;
  }

  if (panel.loadAbort) panel.loadAbort.abort();
  panel.loadAbort = new AbortController();
  const token = panel.loadAbort;

  panel.methodId = methodId;
  updateOverlay(panel, method, method.fileBytes ? "Decoding PLY…" : "Loading PLY…");
  disposeSplat(panel);

  try {
    /** @type {ConstructorParameters<typeof SplatMesh>[0]} */
    const splatOpts = {
      onProgress: (ev) => {
        if (token.signal.aborted) return;
        if (method.fileBytes) {
          updateOverlay(panel, method, "Decoding PLY…");
          return;
        }
        if (ev.lengthComputable && ev.total > 0) {
          const pct = ((100 * ev.loaded) / ev.total).toFixed(0);
          updateOverlay(panel, method, `Downloading ${pct}%…`);
        } else {
          updateOverlay(panel, method, `Downloading ${(ev.loaded / 1e6).toFixed(1)} MB…`);
        }
      },
    };
    if (method.fileBytes) {
      splatOpts.fileBytes = method.fileBytes;
      splatOpts.fileName = method.fileName || method.label || "local.ply";
    } else {
      splatOpts.url = method.url;
    }
    const splat = new SplatMesh(splatOpts);
    panel.scene.add(splat);
    panel.splat = splat;

    await splat.initialized;
    if (token.signal.aborted) return;

    {
      const nRaw = splat.numSplats?.value ?? splat.numSplats;
      if (typeof nRaw === "number" && method.num_gaussians == null) {
        method.num_gaussians = nRaw;
        refreshMethodOptionLabel(methodId);
      }
    }

    const dataparser = method.dataparser || null;
    panel.dataparser = dataparser;
    // Export vertical axis (z for NS); framing always uses oriented COLMAP/Y-up bounds.
    const upAxis = dataparser
      ? method.up_axis === "y" || method.up_axis === "opencv" || method.up_axis === "z"
        ? method.up_axis
        : "z"
      : detectUpAxisFromSplat(splat, method.up_axis);
    panel.upAxis = upAxis;
    if (!method.up_axis) method.up_axis = upAxis;

    applyOrientation(splat, upAxis, dataparser);
    const bounds = getRobustBounds(splat);
    panel.extent = bounds.extent;

    if (isReference || referenceCenter == null || referenceNativeExtent == null) {
      referenceCenter = bounds.center.clone();
      referenceNativeExtent = bounds.extent;
      realignLoadedPanels();
    }

    alignSplatToFrame(splat, upAxis, dataparser);
    if (typeof splat.updateVersion === "function") splat.updateVersion();
    setMoveSpeedForExtent(VIEW_EXTENT);

    updateOverlay(panel, method, "");
    if (fitCamera) placeCameraForScene(true);
  } catch (err) {
    if (token.signal.aborted) return;
    console.error(err);
    updateOverlay(panel, method, `Failed: ${err.message || err}`, true);
  }
}

/**
 * @param {"single"|"dual"|"triple"|"quad"|"hex"} next
 * @param {{ limit?: number|null }} [opts] limit = show only first N slots (experiment)
 */
function setMode(next, { limit = null } = {}) {
  layout =
    next === "hex"
      ? "hex"
      : next === "quad"
        ? "quad"
        : next === "triple"
          ? "triple"
          : next === "dual"
            ? "dual"
            : "single";
  panelLimit = limit;
  stagesEl?.classList.toggle("quad", layout === "quad");
  stagesEl?.classList.toggle("triple", layout === "triple");
  stagesEl?.classList.toggle("hex", layout === "hex");

  const slots = panelSlotsForLayout(layout);
  const n = panelLimit != null ? Math.min(panelLimit, slots.length) : slots.length;
  const visible = new Set(slots.slice(0, n).map((p) => p.stage));
  for (const stage of [stageLeft, stageTc, stageRight, stageBl, stageBc, stageBr]) {
    if (!stage) continue;
    stage.classList.toggle("hidden", !visible.has(stage));
  }

  if (modeSelect) modeSelect.value = layout;
  syncToolbarVisibility();
  resizeSharedRenderer();
}

function syncToolbarVisibility() {
  const isExp = viewerMode === "experiment";
  if (experimentLabel) {
    experimentLabel.style.display = isExp && experiments.length ? "" : "none";
  }
  if (modeSelect) modeSelect.disabled = isExp;

  const leftName = leftLabel?.querySelector(".sel-name");
  const rightName = rightLabel?.querySelector(".sel-name");
  const tcName = tcLabel?.querySelector(".sel-name");
  if (leftName) {
    leftName.textContent =
      layout === "hex" || layout === "quad" || layout === "triple"
        ? "L"
        : layout === "single"
          ? "Model"
          : "Left";
  }
  if (tcName) {
    tcName.textContent = layout === "triple" ? "C" : "TC";
  }
  if (rightName) {
    rightName.textContent =
      layout === "hex" || layout === "quad" || layout === "triple" ? "R" : "Right";
  }

  if (isExp) {
    for (const el of [leftLabel, tcLabel, rightLabel, blLabel, bcLabel, brLabel]) {
      if (el) el.style.display = "none";
    }
    return;
  }

  const showRight = layout !== "single";
  const showTripleCenter = layout === "triple" || layout === "hex";
  const showQuadExtras = layout === "quad" || layout === "hex";
  const showHexExtras = layout === "hex";
  if (leftLabel) leftLabel.style.display = "";
  if (rightLabel) rightLabel.style.display = showRight ? "" : "none";
  if (tcLabel) tcLabel.style.display = showTripleCenter ? "" : "none";
  if (blLabel) blLabel.style.display = showQuadExtras ? "" : "none";
  if (bcLabel) bcLabel.style.display = showHexExtras ? "" : "none";
  if (brLabel) brLabel.style.display = showQuadExtras ? "" : "none";
}

function resizeAll() {
  resizeSharedRenderer();
}

/** Infer experiment id from explicit field or `[tag]` label prefix. */
function experimentIdForMethod(m) {
  if (m.experiment) return String(m.experiment);
  const match = /^\[([^\]]+)\]/.exec(m.label || "");
  return match?.[1]?.trim() || null;
}

/**
 * @param {Method[]} methodsList
 * @param {unknown} manifestExperiments
 * @returns {Experiment[]}
 */
function buildExperiments(methodsList, manifestExperiments) {
  if (Array.isArray(manifestExperiments) && manifestExperiments.length) {
    /** @type {Experiment[]} */
    const out = [];
    for (const raw of manifestExperiments) {
      if (!raw || typeof raw !== "object") continue;
      const id = String(raw.id || "");
      if (!id) continue;
      const methodIds = (Array.isArray(raw.methods) ? raw.methods : [])
        .map(String)
        .filter((mid) => methodById.has(mid));
      if (!methodIds.length) continue;
      out.push({ id, label: String(raw.label || id), methodIds });
    }
    if (out.length) return out;
  }

  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const m of methodsList) {
    const eid = experimentIdForMethod(m);
    if (!eid) continue;
    if (!groups.has(eid)) groups.set(eid, []);
    groups.get(eid).push(m.id);
  }
  return [...groups.entries()].map(([id, methodIds]) => ({
    id,
    label: id,
    methodIds,
  }));
}

function populateExperimentSelect(preferredId) {
  if (!experimentSelect) return;
  experimentSelect.innerHTML = "";
  for (const exp of experiments) {
    const opt = document.createElement("option");
    opt.value = exp.id;
    opt.textContent = `${exp.label} (${exp.methodIds.length})`;
    experimentSelect.appendChild(opt);
  }
  const pick =
    (preferredId && experimentById.has(preferredId) && preferredId) ||
    experiments[0]?.id ||
    "";
  if (pick) experimentSelect.value = pick;
  activeExperimentId = pick || null;

  if (viewerModeSelect) {
    const expOpt = viewerModeSelect.querySelector('option[value="experiment"]');
    if (expOpt) expOpt.disabled = experiments.length === 0;
  }
}

function methodSelects() {
  return [leftSelect, tcSelect, rightSelect, blSelect, bcSelect, brSelect].filter(Boolean);
}

function methodOptionLabel(method) {
  return `${method.label} (${formatCount(method.num_gaussians)})`;
}

function refreshMethodOptionLabel(methodId) {
  const method = methodById.get(methodId);
  if (!method) return;
  const label = methodOptionLabel(method);
  for (const sel of methodSelects()) {
    const opt = [...sel.options].find((o) => o.value === methodId);
    if (opt) opt.textContent = label;
  }
}

function appendMethodToSelects(method) {
  for (const sel of methodSelects()) {
    const opt = document.createElement("option");
    opt.value = method.id;
    opt.textContent = methodOptionLabel(method);
    sel.appendChild(opt);
  }
}

/** Leave experiment mode without reloading panels (local PLY load will refresh left). */
function leaveExperimentModeForLocalLoad() {
  if (viewerMode !== "experiment") return;
  viewerMode = "custom";
  if (viewerModeSelect) viewerModeSelect.value = "custom";
  panelLimit = null;
  setMode(modeSelect?.value || layout || "dual");
  syncToolbarVisibility();
}

async function loadLocalPlyFile(file) {
  if (!file) return;
  const name = file.name || "local.ply";
  if (!/\.ply$/i.test(name)) {
    console.warn("Expected a .ply file:", name);
  }

  leaveExperimentModeForLocalLoad();

  updateOverlay(left, { label: name, num_gaussians: null }, "Reading file…");
  const bytes = await file.arrayBuffer();

  const id = `local_${Date.now()}`;
  /** @type {Method} */
  const method = {
    id,
    label: name,
    fileBytes: bytes,
    fileName: name,
    num_gaussians: null,
    notes: "Loaded from disk",
  };
  methods.push(method);
  methodById.set(id, method);
  appendMethodToSelects(method);
  leftSelect.value = id;

  referenceCenter = null;
  referenceNativeExtent = null;
  await loadMethod(left, id, { fitCamera: true, isReference: true });
  realignLoadedPanels();
}

function populateSelects(manifest) {
  const selects = methodSelects();
  for (const sel of selects) {
    sel.innerHTML = "";
    for (const m of methods) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = methodOptionLabel(m);
      sel.appendChild(opt);
    }
  }
  const pick = (id, fallbackIndex) =>
    methodById.has(id) ? id : methods[fallbackIndex]?.id || methods[0]?.id;

  leftSelect.value = pick(manifest.default_left, 0);
  rightSelect.value = pick(manifest.default_right, 1);
  if (blSelect) blSelect.value = pick(manifest.default_bl, 2);
  if (brSelect) brSelect.value = pick(manifest.default_br, 3);
  if (tcSelect) tcSelect.value = pick(manifest.default_tc, 4);
  if (bcSelect) bcSelect.value = pick(manifest.default_bc, 5);
}

/** Keep custom selects in sync when experiment loads (for switching back). */
function assignSelectsFromIds(ids) {
  const sels = [leftSelect, tcSelect, rightSelect, blSelect, bcSelect, brSelect];
  // Map experiment order onto layout slots: TL TC TR BL BC BR for hex, etc.
  const slotSelects =
    layout === "hex"
      ? [leftSelect, tcSelect, rightSelect, blSelect, bcSelect, brSelect]
      : layout === "quad"
        ? [leftSelect, rightSelect, blSelect, brSelect]
        : layout === "triple"
          ? [leftSelect, tcSelect, rightSelect]
          : layout === "dual"
            ? [leftSelect, rightSelect]
            : [leftSelect];
  for (let i = 0; i < slotSelects.length; i++) {
    const sel = slotSelects[i];
    if (sel && ids[i] && methodById.has(ids[i])) sel.value = ids[i];
  }
  // Fill remaining custom selects with leftovers so they aren't stale.
  let k = slotSelects.length;
  for (const sel of sels) {
    if (!sel || slotSelects.includes(sel)) continue;
    if (ids[k] && methodById.has(ids[k])) sel.value = ids[k];
    k++;
  }
}

let lastFrameTime = performance.now();
function animate(now) {
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  freecam?.update(dt);

  const canvasW = stagesEl.clientWidth;
  const canvasH = stagesEl.clientHeight;
  if (canvasW < 1 || canvasH < 1) return;

  // Viewport/scissor are in drawing-buffer pixels (CSS × devicePixelRatio).
  const pr = sharedRenderer.getPixelRatio();
  sharedRenderer.setScissorTest(true);
  sharedRenderer.setViewport(0, 0, canvasW * pr, canvasH * pr);
  sharedRenderer.setScissor(0, 0, canvasW * pr, canvasH * pr);
  sharedRenderer.setClearColor(0x000000, 1);
  sharedRenderer.clear();

  sharedCamera.updateMatrixWorld(true);

  for (const panel of visiblePanels()) {
    const { x, y, w, h } = stageRect(panel.stage);
    if (w < 1 || h < 1) continue;
    const glY = canvasH - y - h;
    sharedRenderer.setViewport(x * pr, glY * pr, w * pr, h * pr);
    sharedRenderer.setScissor(x * pr, glY * pr, w * pr, h * pr);
    sharedCamera.aspect = w / h;
    sharedCamera.updateProjectionMatrix();
    panel.splat?.updateMatrixWorld?.(true);
    sharedRenderer.render(panel.scene, sharedCamera);
  }
}

async function ensurePanelLoaded(panel, methodId, opts) {
  if (panel.methodId === methodId && panel.splat) return;
  await loadMethod(panel, methodId, opts);
}

async function loadExperiment(expId, { resetRef = true } = {}) {
  const exp = experimentById.get(expId);
  if (!exp?.methodIds?.length) return;
  activeExperimentId = expId;
  if (experimentSelect) experimentSelect.value = expId;

  const ids = exp.methodIds.slice(0, 6);
  const lay = layoutForCount(ids.length);
  setMode(lay, { limit: ids.length });
  assignSelectsFromIds(ids);

  if (resetRef) {
    referenceCenter = null;
    referenceNativeExtent = null;
  }

  const slots = visiblePanels();
  await loadMethod(slots[0], ids[0], { fitCamera: true, isReference: true });
  const tasks = [];
  for (let i = 1; i < ids.length; i++) {
    tasks.push(loadMethod(slots[i], ids[i], { fitCamera: false, isReference: false }));
  }
  await Promise.all(tasks);
  realignLoadedPanels();
}

async function reloadVisible({ resetRef = false } = {}) {
  if (viewerMode === "experiment") {
    const id = activeExperimentId || experimentSelect?.value || experiments[0]?.id;
    if (id) await loadExperiment(id, { resetRef: true });
    return;
  }

  if (resetRef) {
    referenceCenter = null;
    referenceNativeExtent = null;
  }
  panelLimit = null;
  // TL first — its oriented bounds are the shared COLMAP frame for every panel.
  await loadMethod(left, leftSelect.value, { fitCamera: true, isReference: true });
  const tasks = [];
  for (const panel of followerPanels()) {
    const sel =
      panel === tc
        ? tcSelect
        : panel === right
          ? rightSelect
          : panel === bl
            ? blSelect
            : panel === bc
              ? bcSelect
              : brSelect;
    if (sel) tasks.push(loadMethod(panel, sel.value, { fitCamera: false, isReference: false }));
  }
  await Promise.all(tasks);
  realignLoadedPanels();
}

async function setViewerMode(mode) {
  viewerMode = mode === "experiment" && experiments.length ? "experiment" : "custom";
  if (viewerModeSelect) viewerModeSelect.value = viewerMode;
  syncToolbarVisibility();
  if (viewerMode === "experiment") {
    const id = experimentSelect?.value || activeExperimentId || experiments[0]?.id;
    if (id) await loadExperiment(id, { resetRef: true });
  } else {
    panelLimit = null;
    setMode(modeSelect?.value || layout || "dual");
    await reloadVisible({ resetRef: true });
  }
}

const SETTINGS_FIELDS = [
  { id: "set-look", key: "lookSensitivity", fmt: (v) => v.toFixed(4) },
  { id: "set-move", key: "moveScale", fmt: (v) => v.toFixed(2) },
  { id: "set-boost", key: "boostMultiplier", fmt: (v) => `${v.toFixed(1)}×` },
  { id: "set-fine", key: "fineMultiplier", fmt: (v) => `${v.toFixed(2)}×` },
  { id: "set-roll", key: "rollSpeed", fmt: (v) => v.toFixed(1) },
  { id: "set-look-fine", key: "fineLookMultiplier", fmt: (v) => `${v.toFixed(2)}×` },
];

function syncSettingsUI() {
  for (const f of SETTINGS_FIELDS) {
    const input = document.getElementById(f.id);
    const valEl = document.querySelector(`.val[data-for="${f.id}"]`);
    if (!input) continue;
    input.value = String(settings[f.key]);
    if (valEl) valEl.textContent = f.fmt(settings[f.key]);
  }
}

function setupSettingsUI() {
  syncSettingsUI();

  for (const f of SETTINGS_FIELDS) {
    const input = document.getElementById(f.id);
    if (!input) continue;
    input.addEventListener("input", () => {
      settings[f.key] = Number(input.value);
      const valEl = document.querySelector(`.val[data-for="${f.id}"]`);
      if (valEl) valEl.textContent = f.fmt(settings[f.key]);
      saveSettings();
    });
  }

  const toggle = () => {
    settingsPanel?.classList.toggle("open");
  };
  settingsBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });
  settingsClose?.addEventListener("click", () => settingsPanel?.classList.remove("open"));
  settingsReset?.addEventListener("click", () => {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    syncSettingsUI();
  });
}

/** Merge public manifest.json with optional local overlay (pipeline bench / TA assets). */
async function loadMergedManifest() {
  const base = await fetch("./manifest.json").then((r) => {
    if (!r.ok) throw new Error(`manifest.json ${r.status}`);
    return r.json();
  });
  let local = null;
  try {
    const r = await fetch("./manifest.local.json", { cache: "no-store" });
    if (r.ok) local = await r.json();
  } catch (_) {
    /* optional */
  }

  const byId = new Map();
  // Local overlay can replace the public demo list (pipeline fair5 / TA runs).
  if (local?.replace_methods && Array.isArray(local.methods)) {
    for (const m of local.methods) byId.set(m.id, m);
  } else {
    for (const m of base.methods || []) byId.set(m.id, m);
    for (const m of local?.methods || []) byId.set(m.id, m);
  }

  const methodsList = [...byId.values()];
  // Prefer local defaults when they resolve to a known method
  const pickDefault = (localKey, baseKey, fallbackIndex, fallbackId) =>
    (local?.[localKey] && byId.has(local[localKey]) && local[localKey]) ||
    (!local?.replace_methods &&
      base[baseKey] &&
      byId.has(base[baseKey]) &&
      base[baseKey]) ||
    methodsList[fallbackIndex]?.id ||
    fallbackId;

  const default_left = pickDefault("default_left", "default_left", 0, methodsList[0]?.id);
  const default_right = pickDefault("default_right", "default_right", 1, default_left);
  const default_bl = pickDefault("default_bl", "default_bl", 2, default_left);
  const default_br = pickDefault("default_br", "default_br", 3, default_right);
  const default_tc = pickDefault("default_tc", "default_tc", 4, default_left);
  const default_bc = pickDefault("default_bc", "default_bc", 5, default_right);

  return {
    default_left,
    default_right,
    default_bl,
    default_br,
    default_tc,
    default_bc,
    default_viewer_mode: local?.default_viewer_mode || base.default_viewer_mode || "custom",
    default_experiment: local?.default_experiment || base.default_experiment || null,
    experiments: local?.experiments || base.experiments || null,
    methods: methodsList,
  };
}

function bindFollowerSelect(select, panel) {
  select?.addEventListener("change", async () => {
    if (viewerMode === "experiment") return;
    await loadMethod(panel, select.value, { fitCamera: false, isReference: false });
  });
}

function bindLoadPlyInput() {
  loadPlyInput?.addEventListener("change", async () => {
    const file = loadPlyInput.files?.[0];
    loadPlyInput.value = "";
    if (!file) return;
    if (!left) {
      console.warn("Viewer not ready yet; try again in a moment.");
      return;
    }
    try {
      await loadLocalPlyFile(file);
    } catch (err) {
      console.error(err);
      updateOverlay(left, { label: file.name, num_gaussians: null }, `Failed: ${err.message || err}`, true);
    }
  });
}

async function main() {
  bindLoadPlyInput();
  setupSettingsUI();

  const manifest = await loadMergedManifest();
  methods = manifest.methods || [];
  methodById = new Map(methods.map((m) => [m.id, m]));
  if (!methods.length) throw new Error("manifest.json has no methods");

  experiments = buildExperiments(methods, manifest.experiments);
  experimentById = new Map(experiments.map((e) => [e.id, e]));

  populateSelects(manifest);
  populateExperimentSelect(manifest.default_experiment);

  sharedCamera = new THREE.PerspectiveCamera(55, 1, NEAR, FAR);
  sharedCamera.position.set(0, 0.4, 2.5);

  sharedRenderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  sharedRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
  sharedRenderer.domElement.classList.add("spark-canvas");
  stagesEl.insertBefore(sharedRenderer.domElement, stagesEl.firstChild);

  freecam = new FreeCam(sharedCamera, sharedRenderer.domElement);
  freecam.enabled = true;
  updateHint();

  left = createPanel(stageLeft);
  tc = createPanel(stageTc);
  right = createPanel(stageRight);
  bl = createPanel(stageBl);
  bc = createPanel(stageBc);
  br = createPanel(stageBr);

  modeSelect.value = "dual";
  setMode("dual");

  viewerModeSelect?.addEventListener("change", async () => {
    await setViewerMode(viewerModeSelect.value);
  });
  experimentSelect?.addEventListener("change", async () => {
    if (viewerMode !== "experiment") return;
    await loadExperiment(experimentSelect.value, { resetRef: true });
  });

  modeSelect.addEventListener("change", async () => {
    if (viewerMode === "experiment") return;
    const prev = layout;
    setMode(modeSelect.value);
    if (layout === prev || layout === "single") return;
    const tasks = [];
    for (const panel of followerPanels()) {
      if (panel.splat && panel.methodId) continue;
      const sel =
        panel === tc
          ? tcSelect
          : panel === right
            ? rightSelect
            : panel === bl
              ? blSelect
              : panel === bc
                ? bcSelect
                : brSelect;
      if (sel) tasks.push(ensurePanelLoaded(panel, sel.value, { fitCamera: false }));
    }
    await Promise.all(tasks);
    realignLoadedPanels();
    resizeAll();
  });
  leftSelect.addEventListener("change", async () => {
    if (viewerMode === "experiment") return;
    await reloadVisible({ resetRef: true });
  });
  bindFollowerSelect(rightSelect, right);
  bindFollowerSelect(tcSelect, tc);
  bindFollowerSelect(blSelect, bl);
  bindFollowerSelect(bcSelect, bc);
  bindFollowerSelect(brSelect, br);
  resetBtn.addEventListener("click", () => {
    if (!defaultCamPose) return;
    sharedCamera.position.copy(defaultCamPose.position);
    sharedCamera.quaternion.copy(defaultCamPose.quaternion);
    sharedCamera.up.set(0, 1, 0);
  });
  window.addEventListener("resize", resizeAll);
  resizeAll();

  const startMode =
    manifest.default_viewer_mode === "experiment" && experiments.length
      ? "experiment"
      : "custom";
  await setViewerMode(startMode);
  sharedRenderer.setAnimationLoop(animate);
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<pre style="padding:16px;color:#f85149">${err}</pre>`,
  );
});
