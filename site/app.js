// Browser shell for the vendored Play! WebAssembly build.
// Play.js only reads keyboard events on #outputCanvas, and only for the
// codes bound in Source/ui_js (including the non-standard Key0..Key9 codes
// for the shoulder buttons). Touch and physical gamepads are translated
// into those same events. Disc images are streamed from a local File via
// Module.discImageDevice; they are never uploaded.

const EMULATOR_VERSION = "0.77-13-gd44bfa18";

const ALLOWED = new Set(["iso", "cso", "chd", "isz", "bin", "elf"]);

const REMAP = {
  Digit0: "Key0",
  Digit1: "Key1",
  Digit2: "Key2",
  Digit3: "Key3",
  Digit8: "Key8",
  Digit9: "Key9",
  Numpad0: "Key0",
  Numpad1: "Key1",
  Numpad2: "Key2",
  Numpad3: "Key3",
  Numpad8: "Key8",
  Numpad9: "Key9",
  NumpadEnter: "Enter",
};

const HANDLED = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Enter", "Backspace", "NumpadEnter",
  "KeyA", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK", "KeyL",
  "KeyS", "KeyT", "KeyX", "KeyZ",
  "Digit0", "Digit1", "Digit2", "Digit3", "Digit8", "Digit9",
  "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad8", "Numpad9",
]);

const PAD_BUTTONS = {
  0: "KeyZ",
  1: "KeyX",
  2: "KeyA",
  3: "KeyS",
  4: "Key1",
  5: "Key8",
  6: "Key2",
  7: "Key9",
  8: "Backspace",
  9: "Enter",
  10: "Key3",
  11: "Key0",
  12: "ArrowUp",
  13: "ArrowDown",
  14: "ArrowLeft",
  15: "ArrowRight",
};

const TOUCH_KEY = "ps2-touchpad";
const holds = new Map();
const logLines = [];

let playModule = null;
let currentName = "";
let bootGen = 0;
let pendingFile = null;

const statusEl = document.getElementById("status");
const banner = document.getElementById("banner");
const bannerTitle = document.getElementById("banner-title");
const bannerText = document.getElementById("banner-text");
const fpsEl = document.getElementById("fps");
const padStateEl = document.getElementById("pad-state");
const versionEl = document.getElementById("version");
const logEl = document.getElementById("log");
const overlay = document.getElementById("overlay");
const touchBtn = document.getElementById("touch-btn");
const fullscreenBtn = document.getElementById("fullscreen-btn");
const pickBtn = document.getElementById("pick-btn");
const fileInput = document.getElementById("file");
const canvasWrap = document.getElementById("canvas-wrap");
const stage = document.getElementById("stage");

function validateName(name) {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return { ok: false, reason: "noext" };
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext === "cue") return { ok: false, reason: "cue" };
  if (!ALLOWED.has(ext)) return { ok: false, reason: "ext", ext };
  return { ok: true, ext };
}

function messageFor(check) {
  if (check.reason === "cue") {
    return "Файлы CUE эмулятор не читает. Выберите парный BIN, ISO или CHD.";
  }
  if (check.reason === "noext") {
    return "У файла нет расширения. Нужен ISO, CHD, CSO, ISZ, BIN или ELF.";
  }
  return `Формат .${check.ext} не поддерживается. Нужен ISO, CHD, CSO, ISZ, BIN или ELF.`;
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
  if (kind === "ready" || kind === "running" || kind === "error" || kind === "pending") {
    document.documentElement.dataset.emulator = kind === "pending" ? "loading" : kind;
  }
}

function showBanner(title, text) {
  banner.hidden = false;
  bannerTitle.textContent = title;
  bannerText.textContent = text;
}

function hideBanner() {
  banner.hidden = true;
}

function onLog(line) {
  const text = String(line).replace(/\s+$/g, "");
  if (!text) return;
  logLines.push(text);
  if (logLines.length > 80) logLines.shift();
  logEl.textContent = logLines.join("\n");
  const version = text.match(/Play! - Version\s+(\S+)/);
  if (version) versionEl.textContent = "Play! " + version[1];
  if (text.includes("Failed to start")) {
    setStatus("Не удалось запустить образ. Подробности в журнале ниже.", "error");
    showBanner("Образ не запустился", "Проверьте формат файла и откройте журнал эмулятора.");
  } else if (text.includes("Starting")) {
    setStatus(`Идёт «${currentName}». Можно играть.`, "running");
    hideBanner();
  }
}

function dispatchKey(code, down) {
  const canvas = document.getElementById("outputCanvas");
  if (canvas) {
    canvas.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", {
      code,
      key: code,
      bubbles: true,
      cancelable: true,
      repeat: false,
    }));
  }
  document.querySelectorAll(`[data-code="${code}"]`).forEach((el) => {
    el.classList.toggle("held", down);
    el.setAttribute("aria-pressed", down ? "true" : "false");
  });
}

function setKey(code, down, source) {
  let sources = holds.get(code);
  if (!sources) {
    sources = new Set();
    holds.set(code, sources);
  }
  const before = sources.size > 0;
  if (down) sources.add(source);
  else sources.delete(source);
  const after = sources.size > 0;
  if (before !== after) dispatchKey(code, after);
}

function releaseAll() {
  for (const [code, sources] of holds) {
    if (sources.size === 0) continue;
    sources.clear();
    dispatchKey(code, false);
  }
  document.querySelectorAll(".stick.deflected").forEach((el) => {
    el.classList.remove("deflected");
    const nub = el.querySelector(".nub");
    if (nub) nub.style.transform = "translate(-50%, -50%)";
  });
}

function releasePrefix(prefix) {
  for (const [code, sources] of holds) {
    let removed = false;
    for (const source of [...sources]) {
      if (source.startsWith(prefix)) {
        sources.delete(source);
        removed = true;
      }
    }
    if (removed && sources.size === 0) dispatchKey(code, false);
  }
}

function remap(code) {
  return REMAP[code] || code;
}

function onKeyboard(event) {
  if (!event.isTrusted) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (!HANDLED.has(event.code)) return;
  const tag = event.target && event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || (event.target && event.target.isContentEditable)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return;
  setKey(remap(event.code), event.type === "keydown", "kbd:" + remap(event.code));
}

function bindHoldButton(button) {
  const code = button.dataset.code;
  const source = (id) => `touch:${code}:${id}`;
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    try { button.setPointerCapture(event.pointerId); } catch (err) { /* already captured */ }
    setKey(code, true, source(event.pointerId));
  });
  const release = (event) => setKey(code, false, source(event.pointerId));
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
}

function bindStick(stick) {
  const nub = stick.querySelector(".nub");
  const hneg = stick.dataset.hneg;
  const hpos = stick.dataset.hpos;
  const vneg = stick.dataset.vneg;
  const vpos = stick.dataset.vpos;
  const id = stick.dataset.stick;
  let active = null;

  function apply(dx, dy, radius) {
    const dist = Math.hypot(dx, dy);
    const limit = dist > radius && dist > 0 ? radius / dist : 1;
    const cx = dx * limit;
    const cy = dy * limit;
    nub.style.transform = `translate(calc(-50% + ${cx}px), calc(-50% + ${cy}px))`;
    const nx = radius ? cx / radius : 0;
    const ny = radius ? cy / radius : 0;
    const dead = 0.28;
    setKey(hneg, nx < -dead, `stick:${id}:xn`);
    setKey(hpos, nx > dead, `stick:${id}:xp`);
    setKey(vneg, ny < -dead, `stick:${id}:yn`);
    setKey(vpos, ny > dead, `stick:${id}:yp`);
    stick.classList.toggle("deflected", Math.hypot(nx, ny) > dead);
  }

  function reset() {
    active = null;
    nub.style.transform = "translate(-50%, -50%)";
    setKey(hneg, false, `stick:${id}:xn`);
    setKey(hpos, false, `stick:${id}:xp`);
    setKey(vneg, false, `stick:${id}:yn`);
    setKey(vpos, false, `stick:${id}:yp`);
    stick.classList.remove("deflected");
  }

  stick.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    active = event.pointerId;
    try { stick.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
    move(event);
  });

  function move(event) {
    if (event.pointerId !== active) return;
    const rect = stick.getBoundingClientRect();
    const radius = rect.width / 2;
    apply(event.clientX - (rect.left + radius), event.clientY - (rect.top + radius), radius);
  }

  stick.addEventListener("pointermove", move);
  stick.addEventListener("pointerup", (event) => { if (event.pointerId === active) reset(); });
  stick.addEventListener("pointercancel", (event) => { if (event.pointerId === active) reset(); });
}

function axis(value, neg, pos, source) {
  const dead = 0.35;
  setKey(neg, value < -dead, source + "n");
  setKey(pos, value > dead, source + "p");
}

function pollPads() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let pad = null;
  for (const candidate of pads) {
    if (candidate && candidate.connected) {
      pad = candidate;
      break;
    }
  }
  if (!pad) {
    padStateEl.textContent = "";
    releasePrefix("pad:");
  } else {
    padStateEl.textContent = pad.mapping === "standard"
      ? "Геймпад подключён"
      : "Геймпад подключён, раскладка нестандартная";
    for (const [index, code] of Object.entries(PAD_BUTTONS)) {
      const button = pad.buttons[Number(index)];
      const pressed = !!(button && (button.pressed || button.value > 0.4));
      setKey(code, pressed, "pad:b" + index);
    }
    const axes = pad.axes || [];
    axis(axes[0] || 0, "KeyF", "KeyH", "pad:lx");
    axis(axes[1] || 0, "KeyT", "KeyG", "pad:ly");
    axis(axes[2] || 0, "KeyJ", "KeyL", "pad:rx");
    axis(axes[3] || 0, "KeyI", "KeyK", "pad:ry");
  }
  requestAnimationFrame(pollPads);
}

function savedTouch() {
  try {
    const saved = localStorage.getItem(TOUCH_KEY);
    if (saved === "1" || saved === "0") return saved === "1";
  } catch (err) { /* private mode */ }
  return window.matchMedia("(pointer: coarse)").matches;
}

function setTouch(on, persist) {
  overlay.hidden = !on;
  touchBtn.setAttribute("aria-pressed", on ? "true" : "false");
  touchBtn.textContent = on ? "Скрыть геймпад" : "Экранный геймпад";
  if (persist) {
    try { localStorage.setItem(TOUCH_KEY, on ? "1" : "0"); } catch (err) { /* ignore */ }
  }
}

function isFullscreen() {
  return document.fullscreenElement || document.webkitFullscreenElement;
}

function syncFullscreenButton() {
  const on = !!(isFullscreen() || stage.classList.contains("immersive"));
  fullscreenBtn.textContent = on ? "Свернуть" : "На весь экран";
  fullscreenBtn.setAttribute("aria-pressed", on ? "true" : "false");
}

async function toggleFullscreen() {
  if (isFullscreen()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) await exit.call(document);
    syncFullscreenButton();
    return;
  }
  if (stage.classList.contains("immersive")) {
    stage.classList.remove("immersive");
    document.body.classList.remove("immersive-body");
    syncFullscreenButton();
    return;
  }
  const request = stage.requestFullscreen || stage.webkitRequestFullscreen;
  if (!request) {
    stage.classList.add("immersive");
    document.body.classList.add("immersive-body");
    syncFullscreenButton();
    return;
  }
  try {
    await request.call(stage);
  } catch (err) {
    stage.classList.add("immersive");
    document.body.classList.add("immersive-body");
  }
  syncFullscreenButton();
}

class DiscImageDevice {
  constructor(module) {
    this.module = module;
    this.doneFlag = false;
    this.file = null;
  }

  read(dstPtr, offset, size) {
    if (!this.file) throw new Error("No file set.");
    this.doneFlag = false;
    const subsection = this.file.slice(offset, offset + size);
    subsection.arrayBuffer().then((value) => {
      const bytes = new Uint8Array(value);
      const heap = this.module.HEAPU8;
      heap.set(bytes, dstPtr);
      if (bytes.length < size) heap.fill(0, dstPtr + bytes.length, dstPtr + size);
      this.doneFlag = true;
    }).catch((err) => {
      console.error(err);
      this.module.HEAPU8.fill(0, dstPtr, dstPtr + size);
      this.doneFlag = true;
    });
  }

  getFileSize() {
    if (!this.file) throw new Error("No file set.");
    return this.file.size;
  }

  isDone() {
    return this.doneFlag;
  }

  setFile(file) {
    this.file = file;
  }
}

async function bootFile(file) {
  const check = validateName(file.name);
  if (!check.ok) {
    setStatus(messageFor(check), "error");
    showBanner("Файл не подходит", messageFor(check));
    return;
  }
  if (!playModule) {
    pendingFile = file;
    currentName = file.name;
    setStatus(`Файл «${file.name}» выбран. Ждём готовности эмулятора.`, "pending");
    showBanner("Образ выбран", "Эмулятор ещё загружается. Запуск начнётся сам.");
    return;
  }
  const gen = ++bootGen;
  currentName = file.name;
  releaseAll();
  setStatus(`Запуск «${file.name}»… Первые секунды могут ничего не показывать.`, "pending");
  showBanner("Запуск", `«${file.name}». Первые секунды экран может оставаться чёрным.`);
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
  try {
    if (check.ext === "elf") {
      const data = new Uint8Array(await file.arrayBuffer());
      if (gen !== bootGen) return;
      let stream = null;
      try {
        stream = playModule.FS.open(file.name, "w+");
        playModule.FS.write(stream, data, 0, data.length, 0);
      } finally {
        if (stream) playModule.FS.close(stream);
      }
      playModule.bootElf(file.name);
    } else {
      playModule.discImageDevice.setFile(file);
      playModule.bootDiscImage(file.name);
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    setStatus("Не удалось передать образ эмулятору: " + message, "error");
    showBanner("Сбой запуска", message);
  }
}

function hasWebGL2() {
  try {
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("webgl2");
  } catch (err) {
    return false;
  }
}

async function waitForIsolation() {
  if (window.crossOriginIsolated) return;
  setStatus("Включаем SharedArrayBuffer. Страница один раз перезагрузится.", "pending");
  showBanner(
    "Включаем изоляцию",
    "Браузеру нужен SharedArrayBuffer. Страница перезагрузится один раз, это нормально."
  );
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.crossOriginIsolated) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 20000) {
        clearInterval(timer);
        reject(new Error("isolation-timeout"));
      }
    }, 200);
  });
}

async function startEmulator() {
  document.documentElement.dataset.emulator = "loading";
  await waitForIsolation();
  if (!hasWebGL2()) {
    setStatus("Нужен WebGL 2. Обновите браузер или включите аппаратное ускорение.", "error");
    showBanner("Нет WebGL 2", "Без него эмулятор не может рисовать кадр.");
    return;
  }
  setStatus("Загружаем эмулятор Play!…", "pending");
  showBanner("Загружаем эмулятор", "Сборка Play! " + EMULATOR_VERSION + ".");
  const base = new URL("./emulator/", document.baseURI);
  const playUrl = new URL("Play.js?v=" + encodeURIComponent(EMULATOR_VERSION), base).href;
  const Play = (await import(playUrl)).default;
  playModule = await Play({
    locateFile(path) {
      return new URL(path + "?v=" + encodeURIComponent(EMULATOR_VERSION), base).href;
    },
    mainScriptUrlOrBlob: playUrl,
    print: (...args) => onLog(args.join(" ")),
    printErr: (...args) => onLog(args.join(" ")),
  });
  try { playModule.FS.mkdir("/work"); } catch (err) { /* already exists */ }
  playModule.discImageDevice = new DiscImageDevice(playModule);
  playModule.ccall("initVm", "", [], []);
  setInterval(() => {
    if (!playModule) return;
    try {
      const frames = playModule.getFrames();
      playModule.clearStats();
      fpsEl.textContent = frames + " кадр/с";
    } catch (err) { /* stats are optional */ }
  }, 1000);
  setStatus("Эмулятор готов. Выберите образ игры, которой вы владеете.", "ready");
  showBanner(
    "Эмулятор готов",
    "Выберите ISO, CHD, CSO, ISZ, BIN или ELF — или перетащите файл на экран."
  );
  if (pendingFile) {
    const file = pendingFile;
    pendingFile = null;
    bootFile(file);
  }
}

overlay.querySelectorAll("button[data-code]").forEach(bindHoldButton);
overlay.querySelectorAll(".stick").forEach(bindStick);
overlay.addEventListener("contextmenu", (event) => event.preventDefault());

window.addEventListener("keydown", onKeyboard, true);
window.addEventListener("keyup", onKeyboard, true);
window.addEventListener("blur", releaseAll);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAll();
});

touchBtn.addEventListener("click", () => {
  setTouch(overlay.hidden, true);
  touchBtn.blur();
});
fullscreenBtn.addEventListener("click", () => {
  toggleFullscreen();
  fullscreenBtn.blur();
});
document.addEventListener("fullscreenchange", syncFullscreenButton);
document.addEventListener("webkitfullscreenchange", syncFullscreenButton);

pickBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = "";
  if (file) bootFile(file);
});

function hasDroppedFiles(event) {
  return event.dataTransfer && [...event.dataTransfer.types].includes("Files");
}

document.addEventListener("dragover", (event) => {
  if (!hasDroppedFiles(event)) return;
  event.preventDefault();
  canvasWrap.classList.add("dragover");
});
document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) canvasWrap.classList.remove("dragover");
});
document.addEventListener("drop", (event) => {
  if (!hasDroppedFiles(event)) return;
  event.preventDefault();
  canvasWrap.classList.remove("dragover");
  const file = event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) bootFile(file);
});

setTouch(savedTouch(), false);
syncFullscreenButton();
requestAnimationFrame(pollPads);

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
  onLog("Ошибка: " + reason);
  if (document.documentElement.dataset.emulator !== "running") {
    setStatus("Сбой эмулятора. Подробности в журнале.", "error");
  }
});

window.__ps2 = {
  get module() { return playModule; },
  validateName,
  bootFile,
  setKey,
  EMULATOR_VERSION,
};

startEmulator().catch((err) => {
  const isolation = err && err.message === "isolation-timeout";
  const text = isolation
    ? "Не удалось включить SharedArrayBuffer. Откройте сайт в актуальном Chrome или Firefox по HTTPS. В приватном режиме сервис-воркер может быть недоступен."
    : "Не удалось загрузить эмулятор: " + (err && err.message ? err.message : err);
  setStatus(text, "error");
  showBanner(isolation ? "Нет SharedArrayBuffer" : "Эмулятор не загрузился", text);
  onLog(text);
});
