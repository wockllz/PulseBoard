"use strict";
/* Executes a browser script under a minimal DOM stub to catch load-time errors
   (TDZ, missing globals, bad selectors) that unit tests never see. */
const fs = require("fs");
const vm = require("vm");

function stubEl(id) {
  const el = {
    id, value: "", textContent: "", innerHTML: "", style: {}, dataset: {},
    files: [], children: [], disabled: false, checked: false,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener() {}, removeEventListener() {}, appendChild(c) { el.children.push(c); return c; },
    append(...c) { el.children.push(...c); }, prepend() {}, remove() {}, focus() {}, blur() {},
    setAttribute() {}, getAttribute() { return null; }, querySelector() { return stubEl("child"); },
    querySelectorAll() { return []; }, getBoundingClientRect() { return { width: 800, height: 600, left: 0, top: 0 }; },
    getContext() { return new Proxy({}, { get: () => () => ({ addColorStop() {} }) }); },
    insertAdjacentHTML() {}, closest() { return null; }, click() {}
  };
  return el;
}

const file = process.argv[2];
const code = fs.readFileSync(file, "utf8");
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
  requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout,
  performance: { now: () => Date.now() },
  location: { protocol: "http:", host: "localhost:4000", href: "http://localhost:4000/", pathname: "/" },
  navigator: { userAgent: "node" },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {} },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
  WebSocket: function () { this.readyState = 0; this.send = () => {}; this.close = () => {}; this.addEventListener = () => {}; },
  crypto: { randomUUID: () => "uuid-" + Math.random().toString(36).slice(2) },
  document: {
    getElementById: (id) => stubEl(id),
    querySelector: () => stubEl("q"), querySelectorAll: () => [],
    createElement: (t) => stubEl(t), addEventListener() {}, body: stubEl("body"),
    documentElement: stubEl("html"), title: ""
  },
  alert() {}, prompt: () => "test", confirm: () => true
};
sandbox.addEventListener = function () {};
sandbox.removeEventListener = function () {};
sandbox.devicePixelRatio = 1;
sandbox.innerWidth = 1200;
sandbox.innerHeight = 800;
sandbox.matchMedia = () => ({ matches: false, addEventListener() {} });
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file, timeout: 5000 });
  console.log("✓ boots clean:", file.split("/repos/")[1]);
  process.exit(0);
} catch (err) {
  console.log("✗ BOOT ERROR in", file.split("/repos/")[1], "→", err.message);
  process.exit(1);
}
