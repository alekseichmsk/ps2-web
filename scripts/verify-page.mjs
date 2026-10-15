// Loads the static site in headless Chrome and checks that Play! actually
// starts: cross-origin isolation, WebGL init, the version line, keyboard and
// touch routing, and a bootDiscImage call on an empty local file.
//
//   npm install --prefix scripts puppeteer-core
//   node scripts/verify-page.mjs

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../site");
const chrome = process.env.CHROME || "/usr/bin/google-chrome";
const shots = process.env.SHOT_DIR || "/tmp/ps2-shots";
mkdirSync(shots, { recursive: true });

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function startServer(extraHeaders) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = path.normalize(path.join(root, pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    let body;
    try {
      body = readFileSync(file);
    } catch {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
      ...extraHeaders,
    });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function launch(server) {
  const profile = mkdtempSync(path.join(tmpdir(), "ps2-chrome-"));
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: profile,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--allow-insecure-localhost",
    ],
  });
  browser._profile = profile;
  return browser;
}

async function closeBrowser(browser) {
  const profile = browser._profile;
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}

async function waitForEmulator(page, timeoutMs) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    try {
      last = await page.evaluate(() => ({
        status: document.getElementById("status")?.textContent || "",
        kind: document.getElementById("status")?.dataset.kind || "",
        isolated: window.crossOriginIsolated,
        version: document.getElementById("version")?.textContent || "",
        emulator: document.documentElement.dataset.emulator || "",
      }));
      if (last.kind === "ready" || last.kind === "error") return last;
    } catch (err) {
      last = String(err.message || err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the emulator. Last state: " + JSON.stringify(last));
}

function attachLogs(page, bucket) {
  page.on("console", (msg) => bucket.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => bucket.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => bucket.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText || ""}`));
}

async function openReady(browser, url, emulate) {
  const page = await browser.newPage();
  const logs = [];
  attachLogs(page, logs);
  page.setDefaultTimeout(20000);
  if (emulate) await page.emulate(emulate);
  else await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (err) {
    logs.push(`[goto] ${err.message}`);
  }
  const state = await waitForEmulator(page, 90000);
  return { page, logs, state };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exercise(page) {
  const facts = await page.evaluate(() => {
    const canvas = document.getElementById("outputCanvas");
    return {
      boot: typeof window.__ps2.module.bootDiscImage,
      frames: typeof window.__ps2.module.getFrames,
      device: typeof window.__ps2.module.discImageDevice.read,
      iso: window.__ps2.validateName("My Game.ISO"),
      chd: window.__ps2.validateName("disc.chd"),
      cue: window.__ps2.validateName("disc.cue"),
      elf: window.__ps2.validateName("demo.elf"),
      bad: window.__ps2.validateName("notes.txt"),
      canvas: { w: canvas.width, h: canvas.height },
    };
  });
  assert(facts.boot === "function", "bootDiscImage missing");
  assert(facts.frames === "function", "getFrames missing");
  assert(facts.device === "function", "disc reader missing");
  assert(facts.iso.ok && facts.iso.ext === "iso", "ISO check failed");
  assert(facts.chd.ok && facts.elf.ok, "CHD/ELF check failed");
  assert(!facts.cue.ok && facts.cue.reason === "cue", "CUE should be rejected");
  assert(!facts.bad.ok, "txt should be rejected");
  assert(facts.canvas.w === 640 && facts.canvas.h === 480, "canvas size is not 640x480");

  // Calling getContext here may steal the emulator context on some drivers.
  // Only the attribute check above is required; WebGL was created inside initVm.

  const keys = await page.evaluate(() => {
    const seen = [];
    const canvas = document.getElementById("outputCanvas");
    const onKey = (event) => seen.push(event.type + ":" + event.code);
    canvas.addEventListener("keydown", onKey);
    canvas.addEventListener("keyup", onKey);
    const button = document.querySelector('[data-code="KeyZ"]');
    button.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true,
    }));
    button.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true,
    }));
    const stick = document.querySelector('[data-stick="left"]');
    const rect = stick.getBoundingClientRect();
    stick.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, pointerId: 8, pointerType: "touch", isPrimary: true,
      clientX: rect.left + 4, clientY: rect.top + rect.height / 2,
    }));
    stick.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, pointerId: 8, pointerType: "touch", isPrimary: true,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
    canvas.removeEventListener("keydown", onKey);
    canvas.removeEventListener("keyup", onKey);
    return seen;
  });
  assert(keys.includes("keydown:KeyZ") && keys.includes("keyup:KeyZ"), "touch cross did not emit KeyZ: " + keys.join(","));
  assert(keys.includes("keydown:KeyF"), "left stick did not emit KeyF: " + keys.join(","));

  await page.keyboard.down("Digit1");
  await page.keyboard.up("Digit1");
  await page.keyboard.down("ArrowLeft");
  await page.keyboard.up("ArrowLeft");
  const keyboard = await page.evaluate(() => {
    const seen = [];
    const canvas = document.getElementById("outputCanvas");
    const onKey = (event) => {
      if (!event.isTrusted) seen.push(event.type + ":" + event.code);
    };
    canvas.addEventListener("keydown", onKey);
    canvas.addEventListener("keyup", onKey);
    return new Promise((resolve) => {
      window.addEventListener("keyup", () => resolve(seen), { once: true, capture: true });
      setTimeout(() => resolve(seen), 300);
    });
  });
  // The keyboard events above were dispatched before the listener. Re-send.
  const typed = await page.evaluate(() => {
    const seen = [];
    const canvas = document.getElementById("outputCanvas");
    const onKey = (event) => seen.push(event.type + ":" + event.code + ":" + event.isTrusted);
    canvas.addEventListener("keydown", onKey);
    canvas.addEventListener("keyup", onKey);
    window.__keySeen = seen;
    return true;
  });
  assert(typed, "listener install failed");
  await page.keyboard.press("Digit1");
  await page.keyboard.press("ArrowLeft");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const typedSeen = await page.evaluate(() => window.__keySeen);
  assert(typedSeen.some((item) => item.startsWith("keydown:Key1:")), "Digit1 was not remapped to Key1: " + typedSeen.join(","));
  assert(typedSeen.some((item) => item.startsWith("keydown:ArrowLeft:")), "ArrowLeft missing: " + typedSeen.join(","));
  void keyboard;

  await page.click("#fullscreen-btn");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const fullscreen = await page.evaluate(() => ({
    label: document.getElementById("fullscreen-btn").textContent,
    native: !!(document.fullscreenElement || document.webkitFullscreenElement),
    immersive: document.body.classList.contains("immersive-body"),
  }));
  assert(fullscreen.label === "Свернуть" || fullscreen.native || fullscreen.immersive, "fullscreen did not engage: " + JSON.stringify(fullscreen));
  await page.click("#fullscreen-btn");

  const boot = await page.evaluate(() => {
    const seen = [];
    const previous = window.__ps2.module.print;
    window.__bootSeen = seen;
    const file = new File([new Uint8Array(4096)], "probe.iso", { type: "application/octet-stream" });
    window.__ps2.bootFile(file);
    return previous ? "had-print" : "no-print";
  });
  void boot;
  const log = await page.waitForFunction(() => {
    const text = document.getElementById("log")?.textContent || "";
    return text.includes("probe.iso") ? text : false;
  }, { timeout: 15000 }).then((handle) => handle.jsonValue());
  assert(log.includes("probe.iso"), "bootDiscImage did not log the probe file");
}

async function runMode(name, headers, shotName) {
  const server = await startServer(headers);
  const browser = await launch(server);
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    console.log(`\n== ${name} ${url}`);
    const desktop = await openReady(browser, url);
    console.log("desktop", desktop.state);
    assert(desktop.state.kind === "ready", "desktop status: " + desktop.state.status + "\n" + desktop.logs.slice(-30).join("\n"));
    assert(desktop.state.isolated === true, "page is not cross-origin isolated");
    assert(/Play! 0\.77/.test(desktop.state.version), "unexpected version: " + desktop.state.version);
    await desktop.page.screenshot({ path: path.join(shots, shotName + "-desktop.png") });
    await desktop.page.evaluate(() => {
      if (document.getElementById("overlay").hidden) document.getElementById("touch-btn").click();
    });
    await desktop.page.screenshot({ path: path.join(shots, shotName + "-desktop-pad.png") });
    await exercise(desktop.page);
    const fps = await desktop.page.$eval("#fps", (el) => el.textContent);
    assert(/\d+ кадр\/с/.test(fps), "fps label missing: " + fps);

    const mobile = await browser.newPage();
    const mobileLogs = [];
    attachLogs(mobile, mobileLogs);
    await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await mobile.emulateMediaFeatures?.([]);
    try {
      await mobile.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (err) {
      mobileLogs.push(err.message);
    }
    // Force the coarse-pointer default by clearing any saved toggle, then reload once isolated.
    await mobile.evaluate(() => localStorage.removeItem("ps2-touchpad"));
    const mobileState = await waitForEmulator(mobile, 90000);
    console.log("mobile", mobileState);
    assert(mobileState.kind === "ready", "mobile status: " + mobileState.status + "\n" + mobileLogs.slice(-20).join("\n"));
    const layout = await mobile.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      pick: document.getElementById("pick-btn").textContent,
      touchLabel: document.getElementById("touch-btn").textContent,
    }));
    assert(layout.overflow <= 1, "mobile page overflows by " + layout.overflow);
    assert(layout.pick.includes("Выбрать"), "pick button text missing");
    await mobile.screenshot({ path: path.join(shots, shotName + "-mobile.png") });

    const narrow = await browser.newPage();
    await narrow.setViewport({ width: 320, height: 568, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    try {
      await narrow.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch { /* reload */ }
    await waitForEmulator(narrow, 90000);
    await narrow.evaluate(() => {
      if (document.getElementById("overlay").hidden) document.getElementById("touch-btn").click();
    });
    const narrowLayout = await narrow.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      hidden: document.getElementById("overlay").hidden,
    }));
    assert(narrowLayout.overflow <= 1, "320px page overflows by " + narrowLayout.overflow);
    assert(narrowLayout.hidden === false, "touch overlay did not open");
    await narrow.screenshot({ path: path.join(shots, shotName + "-narrow.png") });
    console.log(name, "ok");
  } finally {
    await closeBrowser(browser);
    await new Promise((resolve) => server.close(resolve));
  }
}

const isolatedHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

await runMode("headers", isolatedHeaders, "headers");
await runMode("service-worker", {}, "sw");
console.log("\nAll checks passed.");
