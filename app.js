import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

const modeSelect = document.getElementById("mode");
const controlModeSelect = document.getElementById("control-mode");
const leftSelect = document.getElementById("left-method");
const rightSelect = document.getElementById("right-method");
const blSelect = document.getElementById("bl-method");
const brSelect = document.getElementById("br-method");
const leftLabel = document.getElementById("left-label");
const rightLabel = document.getElementById("right-label");
const blLabel = document.getElementById("bl-label");
const brLabel = document.getElementById("br-label");
const resetBtn = document.getElementById("reset-cam");
const settingsBtn = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings-panel");
const settingsClose = document.getElementById("settings-close");
const settingsReset = document.getElementById("settings-reset");
const hintEl = document.querySelector("#toolbar .hint");
const stagesEl = document.getElementById("stages");
const stageLeft = document.getElementById("stage-left");
const stageRight = document.getElementById("stage-right");
const stageBl = document.getElementById("stage-bl");
const stageBr = document.getElementById("stage-br");

const SETTINGS_KEY = "gs-compare-controls-v2";
const DEFAULT_SETTINGS = {
  lookSensitivity: 0.002,
  moveScale: 1.0,
  boostMultiplier: 3.5,
  fineMultiplier: 0.2,
  rollSpeed: 1.8,
  fineLookMultiplier: 0.35,
  orbitSensitivity: 1.0,
  orbitPivotDistance: 2.5,
  controlMode: "freecam",
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

/** @type {{ id: string, label: string, url: string, num_gaussians?: number|null, psnr?: number|null, ssim?: number|null, lpips?: number|null, peak_vram_mib?: number|null, notes?: string|null }[]} */
let methods = [];
let methodById = new Map();

/**
 * @typedef {object} Panel
 * @property {HTMLElement} stage
 * @property {HTMLElement} overlay
 * @property {THREE.Scene} scene
 * @property {THREE.PerspectiveCamera} camera
 * @property {THREE.WebGLRenderer} renderer
 * @property {SparkRenderer} spark
 * @property {FreeCam|null} freecam
 * @property {OrbitCam|null} orbit
 * @property {SplatMesh|null} splat
 * @property {string|null} methodId
 * @property {AbortController|null} loadAbort
 * @property {number|null} extent
 */

/** @type {Panel} */
let left;
/** @type {Panel} */
let right;
/** @type {Panel} */
let bl;
/** @type {Panel} */
let br;
/** @type {"single"|"dual"|"quad"} */
let layout = "dual";
/** Shared robust scene size used to align panels and tune move speed. */
let referenceExtent = null;
/** World-space robust center from the reference model (shared by all panels). */
let referenceCenter = null;
let defaultCamPose = null;
/** @type {"freecam"|"orbit"} */
let controlMode = settings.controlMode === "orbit" ? "orbit" : "freecam";

const NEAR = 0.001;
const FAR = 5000;
const HINT_FREECAM =
  "First person: click to fly · WASD · Space/Ctrl · RMB fine · Shift boost · Q/E roll · Tab exit";
const HINT_FREECAM_LOCKED =
  "Flying · WASD · Space/Ctrl · RMB fine · Shift boost · Q/E roll · Tab to release";
const HINT_ORBIT =
  "Orbit: LMB orbit · RMB pan · wheel orbit · Ctrl+wheel dolly · Shift+wheel pan · WASD/QE rotate";

function updateHint() {
  if (!hintEl) return;
  if (controlMode === "orbit") {
    hintEl.textContent = HINT_ORBIT;
  } else if (left?.freecam?.isLocked) {
    hintEl.textContent = HINT_FREECAM_LOCKED;
  } else {
    hintEl.textContent = HINT_FREECAM;
  }
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
      if (this.isLocked || controlMode === "orbit") e.preventDefault();
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

/**
 * Antimatter15/splat-style orbit: LMB orbits around a point in front of the
 * camera, RMB pans (strafe + dolly), wheel orbits / Ctrl dollies / Shift pans.
 * WASD/QE nudge rotations like the original viewer.
 */
class OrbitCam {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} domElement
   */
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.enabled = false;
    this.sceneScale = 1.0;
    this._down = 0; // 0 none, 1 LMB orbit, 2 RMB pan
    this._lastX = 0;
    this._lastY = 0;
    this._keys = new Set();

    domElement.addEventListener("mousedown", (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      this._down = e.button === 2 || e.ctrlKey || e.metaKey ? 2 : 1;
    });
    domElement.addEventListener("mouseup", () => {
      this._down = 0;
    });
    domElement.addEventListener("mouseleave", () => {
      this._down = 0;
    });
    domElement.addEventListener("mousemove", (e) => {
      if (!this.enabled || !this._down) return;
      e.preventDefault();
      const w = Math.max(domElement.clientWidth, 1);
      const h = Math.max(domElement.clientHeight, 1);
      const dx = (e.clientX - this._lastX) / w;
      const dy = (e.clientY - this._lastY) / h;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      const sens = settings.orbitSensitivity;
      if (this._down === 1) {
        this._orbit(5 * dx * sens, -5 * dy * sens);
      } else if (this._down === 2) {
        this._pan((-10 * dx * sens) / 1, (10 * dy * sens) / 1);
      }
    });
    domElement.addEventListener(
      "wheel",
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        const scale = e.deltaMode === 1 ? 10 : e.deltaMode === 2 ? domElement.clientHeight : 1;
        const sens = settings.orbitSensitivity;
        const ndx = (-(e.deltaX * scale) / Math.max(domElement.clientWidth, 1)) * sens;
        const ndy = ((e.deltaY * scale) / Math.max(domElement.clientHeight, 1)) * sens;
        if (e.shiftKey) {
          this._pan(10 * ndx, -10 * ndy);
        } else if (e.ctrlKey || e.metaKey) {
          this.camera.translateZ(10 * ndy * this.sceneScale * 0.15);
        } else {
          this._orbit(4 * ndx, 4 * ndy);
        }
      },
      { passive: false },
    );

    window.addEventListener("keydown", (e) => {
      if (!this.enabled) return;
      this._keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => {
      this._keys.delete(e.code);
    });
  }

  /** Pivot distance in world units (scaled like antimatter's d=4). */
  _pivotD() {
    return Math.max(0.2, settings.orbitPivotDistance * this.sceneScale * 0.35);
  }

  /** Orbit around a point `d` units in front of the camera (antimatter style). */
  _orbit(yaw, pitch) {
    const d = this._pivotD();
    this.camera.translateZ(-d);
    this.camera.rotateY(yaw);
    this.camera.rotateX(pitch);
    this.camera.translateZ(d);
  }

  /** Pan: local X + local Z like antimatter RMB. */
  _pan(tx, tz) {
    const s = this.sceneScale * 0.35;
    this.camera.translateX(tx * s);
    this.camera.translateZ(tz * s);
  }

  setSceneScale(extent) {
    this.sceneScale = Math.max(extent, 0.5);
  }

  /** @param {number} dt */
  update(dt) {
    if (!this.enabled) return;
    const r = 1.2 * settings.orbitSensitivity * dt * 60;
    if (this._keys.has("KeyA")) this.camera.rotateY(0.01 * r);
    if (this._keys.has("KeyD")) this.camera.rotateY(-0.01 * r);
    if (this._keys.has("KeyW")) this.camera.rotateX(0.005 * r);
    if (this._keys.has("KeyS")) this.camera.rotateX(-0.005 * r);
    if (this._keys.has("KeyQ")) this.camera.rotateZ(0.01 * r);
    if (this._keys.has("KeyE")) this.camera.rotateZ(-0.01 * r);
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

function createPanel(stageEl, withControls) {
  const overlay = stageEl.querySelector(".overlay");
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(55, 1, NEAR, FAR);
  camera.position.set(0, 0.4, 2.5);

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  stageEl.appendChild(renderer.domElement);

  const spark = new SparkRenderer({
    renderer,
    minPixelRadius: 0.0,
    maxPixelRadius: 512.0,
    clipXY: 1.4,
  });
  scene.add(spark);

  /** @type {FreeCam|null} */
  let freecam = null;
  /** @type {OrbitCam|null} */
  let orbit = null;
  if (withControls) {
    freecam = new FreeCam(camera, renderer.domElement);
    orbit = new OrbitCam(camera, renderer.domElement);
  }

  return {
    stage: stageEl,
    overlay,
    scene,
    camera,
    renderer,
    spark,
    freecam,
    orbit,
    splat: null,
    methodId: null,
    loadAbort: null,
    extent: null,
  };
}

function resizePanel(panel) {
  const w = panel.stage.clientWidth;
  const h = panel.stage.clientHeight;
  if (w < 1 || h < 1) return;
  panel.camera.aspect = w / h;
  panel.camera.near = NEAR;
  panel.camera.far = FAR;
  panel.camera.updateProjectionMatrix();
  panel.renderer.setSize(w, h, false);
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
    localBox = new THREE.Box3(
      new THREE.Vector3(pct(xs, 0.05), pct(ys, 0.05), pct(zs, 0.05)),
      new THREE.Vector3(pct(xs, 0.95), pct(ys, 0.95), pct(zs, 0.95)),
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
 * Put every model into a comparable viewing frame:
 * OpenCV→Y-up, *shared* uniform scale (from the reference model), and each model's
 * own robust center → origin.
 *
 * Shared COLMAP translation alone breaks when mixing exporters (official 3DGS vs
 * Nerfstudio) that don't share the same numerical frame — panels look "out of sync"
 * under a locked camera. Own-center + shared scale keeps orbit/freecam matched.
 */
function alignSplatToFrame(splat, _frameCenter, frameExtent, targetExtent) {
  splat.position.set(0, 0, 0);
  splat.scale.setScalar(1);
  splat.quaternion.set(1, 0, 0, 0); // OpenCV / COLMAP → Y-up
  splat.updateMatrixWorld(true);

  const own = getRobustBounds(splat);
  const s = targetExtent / Math.max(frameExtent, 1e-6);
  splat.scale.setScalar(s);
  splat.position.copy(own.center).multiplyScalar(-s);
  splat.updateMatrixWorld(true);
}

/** Re-apply the shared scale / per-model recenter (e.g. after TL changes). */
function realignLoadedPanels() {
  if (referenceExtent == null) return;
  for (const panel of visiblePanels()) {
    if (!panel.splat) continue;
    alignSplatToFrame(panel.splat, referenceCenter, referenceExtent, referenceExtent);
  }
}

function visiblePanels() {
  const panels = [left];
  if (layout !== "single") panels.push(right);
  if (layout === "quad") panels.push(bl, br);
  return panels.filter(Boolean);
}

function setMoveSpeedForExtent(extent) {
  if (!left) return;
  const base = Math.max(0.2, extent * 0.4);
  left.freecam?.setMoveSpeed(base);
  left.orbit?.setSceneScale(extent);
}

function setControlMode(mode) {
  controlMode = mode === "orbit" ? "orbit" : "freecam";
  settings.controlMode = controlMode;
  saveSettings();
  if (controlModeSelect) controlModeSelect.value = controlMode;

  if (!left) {
    updateHint();
    return;
  }

  if (controlMode === "freecam") {
    left.orbit.enabled = false;
    left.freecam.enabled = true;
  } else {
    left.freecam.unlock();
    left.freecam.enabled = false;
    left.orbit.enabled = true;
    left.renderer.domElement.style.cursor = "grab";
  }
  updateHint();
}

function placeCameraForScene(panel, extent, storeAsDefault) {
  panel.camera.near = NEAR;
  panel.camera.far = FAR;
  panel.camera.updateProjectionMatrix();

  const dist = Math.max(extent * 0.9, 0.5);
  panel.camera.position.set(dist * 0.15, dist * 0.25, dist);
  panel.camera.up.set(0, 1, 0);
  panel.camera.lookAt(0, 0, 0);

  if (storeAsDefault) {
    defaultCamPose = {
      position: panel.camera.position.clone(),
      quaternion: panel.camera.quaternion.clone(),
    };
  }
}

/** Follower panels that mirror the control (TL / left) camera. */
function followerPanels() {
  if (layout === "quad") return [right, bl, br];
  if (layout === "dual") return [right];
  return [];
}

/** Copy control (TL/left) pose into a panel camera; aspect set by caller/resize. */
function copyPoseFromLeft(panel) {
  if (!left || !panel || panel === left) return;
  panel.camera.position.copy(left.camera.position);
  panel.camera.quaternion.copy(left.camera.quaternion);
  panel.camera.up.copy(left.camera.up);
  panel.camera.fov = left.camera.fov;
  panel.camera.near = left.camera.near;
  panel.camera.far = left.camera.far;
}

function syncFollowersFromLeft() {
  if (!left) return;
  left.camera.updateMatrixWorld(true);
  for (const panel of followerPanels()) {
    copyPoseFromLeft(panel);
    panel.camera.aspect = left.camera.aspect;
    panel.camera.updateProjectionMatrix();
    panel.camera.updateMatrixWorld(true);
  }
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
  updateOverlay(panel, method, "Loading PLY…");
  disposeSplat(panel);

  try {
    const splat = new SplatMesh({
      url: method.url,
      onProgress: (ev) => {
        if (token.signal.aborted) return;
        if (ev.lengthComputable && ev.total > 0) {
          const pct = ((100 * ev.loaded) / ev.total).toFixed(0);
          updateOverlay(panel, method, `Downloading ${pct}%…`);
        } else {
          updateOverlay(panel, method, `Downloading ${(ev.loaded / 1e6).toFixed(1)} MB…`);
        }
      },
    });
    panel.scene.add(splat);
    panel.splat = splat;

    await splat.initialized;
    if (token.signal.aborted) return;

    {
      const nRaw = splat.numSplats?.value ?? splat.numSplats;
      if (typeof nRaw === "number" && method.num_gaussians == null) {
        method.num_gaussians = nRaw;
      }
    }

    // OpenCV→Y-up, then measure native bounds in that orientation.
    splat.position.set(0, 0, 0);
    splat.scale.setScalar(1);
    splat.quaternion.set(1, 0, 0, 0);
    splat.updateMatrixWorld(true);
    const bounds = getRobustBounds(splat);
    panel.extent = bounds.extent;

    if (isReference || referenceExtent == null || referenceCenter == null) {
      referenceExtent = bounds.extent;
      referenceCenter = bounds.center.clone();
      // Reference changed: keep other loaded panels in the same world frame.
      realignLoadedPanels();
    }

    alignSplatToFrame(splat, referenceCenter, referenceExtent, referenceExtent);
    setMoveSpeedForExtent(referenceExtent);

    updateOverlay(panel, method, "");
    if (fitCamera) placeCameraForScene(panel, referenceExtent, true);
  } catch (err) {
    if (token.signal.aborted) return;
    console.error(err);
    updateOverlay(panel, method, `Failed: ${err.message || err}`, true);
  }
}

function setMode(next) {
  layout = next === "quad" ? "quad" : next === "dual" ? "dual" : "single";
  stagesEl?.classList.toggle("quad", layout === "quad");

  stageRight.classList.toggle("hidden", layout === "single");
  stageBl.classList.toggle("hidden", layout !== "quad");
  stageBr.classList.toggle("hidden", layout !== "quad");

  const leftName = leftLabel?.querySelector(".sel-name");
  const rightName = rightLabel?.querySelector(".sel-name");
  if (leftName) {
    leftName.textContent = layout === "quad" ? "TL" : layout === "single" ? "Model" : "Left";
  }
  if (rightName) {
    rightName.textContent = layout === "quad" ? "TR" : "Right";
  }
  rightLabel.style.display = layout === "single" ? "none" : "";
  if (blLabel) blLabel.style.display = layout === "quad" ? "" : "none";
  if (brLabel) brLabel.style.display = layout === "quad" ? "" : "none";

  resizeAll();
  syncFollowersFromLeft();
}

function resizeAll() {
  resizePanel(left);
  for (const panel of followerPanels()) resizePanel(panel);
}

function populateSelects(manifest) {
  const selects = [leftSelect, rightSelect, blSelect, brSelect].filter(Boolean);
  for (const sel of selects) {
    sel.innerHTML = "";
    for (const m of methods) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.label} (${formatCount(m.num_gaussians)})`;
      sel.appendChild(opt);
    }
  }
  const pick = (id, fallbackIndex) =>
    methodById.has(id) ? id : methods[fallbackIndex]?.id || methods[0]?.id;

  leftSelect.value = pick(manifest.default_left, 0);
  rightSelect.value = pick(manifest.default_right, 1);
  if (blSelect) blSelect.value = pick(manifest.default_bl, 2);
  if (brSelect) brSelect.value = pick(manifest.default_br, 3);
}

let lastFrameTime = performance.now();
function animate(now) {
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  if (controlMode === "freecam") left.freecam?.update(dt);
  else left.orbit?.update(dt);

  // Per-panel cameras, pose copied every frame. Sharing one Camera across multiple
  // WebGLRenderers/Spark paths can drift; mutating aspect on a shared cam is worse.
  left.camera.updateMatrixWorld(true);

  for (const panel of visiblePanels()) {
    const w = panel.stage.clientWidth;
    const h = panel.stage.clientHeight;
    if (w < 1 || h < 1) continue;

    if (panel !== left) copyPoseFromLeft(panel);
    panel.camera.aspect = w / h;
    panel.camera.updateProjectionMatrix();
    panel.camera.updateMatrixWorld(true);
    panel.splat?.updateMatrixWorld?.(true);
    panel.renderer.render(panel.scene, panel.camera);
  }
}

async function ensurePanelLoaded(panel, methodId, opts) {
  if (panel.methodId === methodId && panel.splat) return;
  await loadMethod(panel, methodId, opts);
}

async function reloadVisible({ resetRef = false } = {}) {
  if (resetRef) {
    referenceExtent = null;
    referenceCenter = null;
  }
  await loadMethod(left, leftSelect.value, { fitCamera: true, isReference: true });
  const tasks = [];
  if (layout !== "single") {
    tasks.push(loadMethod(right, rightSelect.value, { fitCamera: false, isReference: false }));
  }
  if (layout === "quad") {
    tasks.push(loadMethod(bl, blSelect.value, { fitCamera: false, isReference: false }));
    tasks.push(loadMethod(br, brSelect.value, { fitCamera: false, isReference: false }));
  }
  await Promise.all(tasks);
  realignLoadedPanels();
  syncFollowersFromLeft();
}

const SETTINGS_FIELDS = [
  { id: "set-look", key: "lookSensitivity", fmt: (v) => v.toFixed(4) },
  { id: "set-move", key: "moveScale", fmt: (v) => v.toFixed(2) },
  { id: "set-boost", key: "boostMultiplier", fmt: (v) => `${v.toFixed(1)}×` },
  { id: "set-fine", key: "fineMultiplier", fmt: (v) => `${v.toFixed(2)}×` },
  { id: "set-roll", key: "rollSpeed", fmt: (v) => v.toFixed(1) },
  { id: "set-look-fine", key: "fineLookMultiplier", fmt: (v) => `${v.toFixed(2)}×` },
  { id: "set-orbit", key: "orbitSensitivity", fmt: (v) => v.toFixed(2) },
  { id: "set-orbit-d", key: "orbitPivotDistance", fmt: (v) => v.toFixed(1) },
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
    setControlMode(settings.controlMode);
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
  for (const m of base.methods || []) byId.set(m.id, m);
  for (const m of local?.methods || []) byId.set(m.id, m); // local overrides / adds

  const methodsList = [...byId.values()];
  // Prefer local defaults when they resolve to a known method
  const pickDefault = (localKey, baseKey, fallbackIndex, fallbackId) =>
    (local?.[localKey] && byId.has(local[localKey]) && local[localKey]) ||
    (base[baseKey] && byId.has(base[baseKey]) && base[baseKey]) ||
    methodsList[fallbackIndex]?.id ||
    fallbackId;

  const default_left = pickDefault("default_left", "default_left", 0, methodsList[0]?.id);
  const default_right = pickDefault("default_right", "default_right", 1, default_left);
  const default_bl = pickDefault("default_bl", "default_bl", 2, default_left);
  const default_br = pickDefault("default_br", "default_br", 3, default_right);

  return { default_left, default_right, default_bl, default_br, methods: methodsList };
}

async function main() {
  setupSettingsUI();

  const manifest = await loadMergedManifest();
  methods = manifest.methods || [];
  methodById = new Map(methods.map((m) => [m.id, m]));
  if (!methods.length) throw new Error("manifest.json has no methods");

  populateSelects(manifest);

  left = createPanel(stageLeft, true);
  right = createPanel(stageRight, false);
  bl = createPanel(stageBl, false);
  br = createPanel(stageBr, false);

  modeSelect.value = "dual";
  setMode("dual");
  setControlMode(controlMode);

  modeSelect.addEventListener("change", async () => {
    const prev = layout;
    setMode(modeSelect.value);
    if (layout === prev) return;
    // Load any newly visible panels; skip full reload when possible.
    if (layout === "single") return;
    const tasks = [];
    if (prev === "single" || (layout === "quad" && prev === "dual")) {
      // dual←single or quad←dual/single: ensure newly shown panels
      if (prev === "single") {
        tasks.push(ensurePanelLoaded(right, rightSelect.value, { fitCamera: false }));
      }
      if (layout === "quad") {
        tasks.push(ensurePanelLoaded(bl, blSelect.value, { fitCamera: false }));
        tasks.push(ensurePanelLoaded(br, brSelect.value, { fitCamera: false }));
      }
    }
    await Promise.all(tasks);
    syncFollowersFromLeft();
    resizeAll();
  });
  controlModeSelect?.addEventListener("change", () => {
    setControlMode(controlModeSelect.value);
  });
  leftSelect.addEventListener("change", async () => {
    await reloadVisible({ resetRef: true });
  });
  rightSelect.addEventListener("change", async () => {
    await loadMethod(right, rightSelect.value, { fitCamera: false, isReference: false });
    syncFollowersFromLeft();
  });
  blSelect?.addEventListener("change", async () => {
    await loadMethod(bl, blSelect.value, { fitCamera: false, isReference: false });
    syncFollowersFromLeft();
  });
  brSelect?.addEventListener("change", async () => {
    await loadMethod(br, brSelect.value, { fitCamera: false, isReference: false });
    syncFollowersFromLeft();
  });
  resetBtn.addEventListener("click", () => {
    if (!defaultCamPose) return;
    left.camera.position.copy(defaultCamPose.position);
    left.camera.quaternion.copy(defaultCamPose.quaternion);
    left.camera.up.set(0, 1, 0);
    syncFollowersFromLeft();
  });

  window.addEventListener("resize", resizeAll);
  resizeAll();

  await reloadVisible({ resetRef: true });
  left.renderer.setAnimationLoop(animate);
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<pre style="padding:16px;color:#f85149">${err}</pre>`,
  );
});
