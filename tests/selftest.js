"use strict";
/**
 * PulseBoard end-to-end self test.
 * Real HTTP + real WebSockets: two clients, live sync, presence, cursors,
 * last-write-wins conflicts, idempotent replay, history reconstruction.
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const WebSocket = require("ws");

const ROOT = path.join(__dirname, "..");
let failures = 0;

function ok(label, condition, detail) {
  if (condition) console.log("  ✓ " + label + (detail ? ` — ${detail}` : ""));
  else { failures += 1; console.log("  ✗ " + label + (detail ? ` — ${detail}` : "")); }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for " + label);
    await sleep(150);
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on("message", (raw) => {
      try { messages.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

async function waitMessage(client, predicate, timeoutMs = 4000) {
  return waitFor(() => client.messages.find(predicate), timeoutMs, "ws message");
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-test-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const app = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: { ...process.env, PORT: String(port), PB_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let exitCode = 1;
  let a = null;
  let b = null;

  try {
    console.log("\n== PulseBoard self test ==\n[boot] server");
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 20000, "server");
    ok("server boots + health check", true);

    const post = (url, body) =>
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    // ---- rooms + default board
    const rooms = await (await fetch(`${base}/api/rooms`)).json();
    ok("default room exists on first boot", rooms.rooms.length === 1, rooms.rooms[0] && rooms.rooms[0].name);

    const created = await (await post(`${base}/api/rooms`, { name: "Sprint 1" })).json();
    const roomId = created.room.id;
    ok("room created", !!roomId && created.room.name === "Sprint 1");

    const badRoom = await fetch(`${base}/api/rooms/nope`);
    ok("unknown room gives 404", badRoom.status === 404);

    // ---- two live clients
    a = await connect(`ws://127.0.0.1:${port}`);
    b = await connect(`ws://127.0.0.1:${port}`);
    ok("two websocket clients connected", a.ws.readyState === 1 && b.ws.readyState === 1);

    a.ws.send(JSON.stringify({ kind: "join", room: roomId, client: "client-a", name: "Alex", color: "#5eb8ff" }));
    await waitMessage(a, (m) => m.kind === "joined");
    ok("client A joined the room", true);

    b.ws.send(JSON.stringify({ kind: "join", room: roomId, client: "client-b", name: "Sam", color: "#55d6a0" }));
    await waitMessage(b, (m) => m.kind === "joined");
    ok("client B joined the room", true);

    const presenceA = await waitMessage(a, (m) => m.kind === "presence" && m.clients.length === 2);
    ok("presence broadcast shows both users", presenceA.clients.length === 2, presenceA.clients.map((c) => c.name).join(" + "));

    // ---- API create -> broadcast to both clients
    const cardRes = await (await post(`${base}/api/rooms/${roomId}/cards`, { title: "Ship the landing page", status: "todo" })).json();
    ok("card created via API", !!cardRes.card && cardRes.card.title === "Ship the landing page");

    const broadcastA = await waitMessage(a, (m) => m.kind === "op" && m.op.type === "card-create");
    const broadcastB = await waitMessage(b, (m) => m.kind === "op" && m.op.type === "card-create");
    ok("create broadcast to client A", !!broadcastA);
    ok("create broadcast to client B", !!broadcastB);

    const cardId = cardRes.card.id;

    // ---- move card from A -> B receives, DB reflects
    const moveOp = { id: "op-move-1", type: "card-update", cardId, ts: Date.now(), client: "client-a", payload: { status: "doing" } };
    a.ws.send(JSON.stringify({ kind: "op", room: roomId, op: moveOp }));
    const moved = await waitMessage(b, (m) => m.kind === "op" && m.op.id === "op-move-1");
    ok("move synced from A to B", !!moved && moved.card.status === "doing");

    const roomState = await (await fetch(`${base}/api/rooms/${roomId}`)).json();
    ok("database reflects the move", roomState.cards[0].status === "doing");

    // ---- idempotency: replay the same op id
    const replay = await (await post(`${base}/api/rooms/${roomId}/ops`, { op: moveOp })).json();
    ok("duplicate op rejected as duplicate", replay.duplicate === true && replay.applied === false);

    // ---- last-write-wins: older op must not overwrite newer
    const olderOp = { id: "op-old", type: "card-update", cardId, ts: Date.now() - 60000, client: "client-b", payload: { title: "OLD TITLE" } };
    await post(`${base}/api/rooms/${roomId}/ops`, { op: olderOp });
    const afterOld = await (await fetch(`${base}/api/rooms/${roomId}`)).json();
    ok("last-write-wins ignores stale update", afterOld.cards[0].title === "Ship the landing page", afterOld.cards[0].title);

    const newerOp = { id: "op-new", type: "card-update", cardId, ts: Date.now() + 1000, client: "client-b", payload: { title: "Ship the landing page v2" } };
    await post(`${base}/api/rooms/${roomId}/ops`, { op: newerOp });
    const afterNew = await (await fetch(`${base}/api/rooms/${roomId}`)).json();
    ok("newer update wins", afterNew.cards[0].title === "Ship the landing page v2");

    // ---- offline queue replay (client reconnects and flushes 2 ops)
    const offlineOps = [
      { id: "op-offline-1", type: "card-create", cardId: "offline-card-1", ts: Date.now(), client: "client-c", payload: { title: "Offline note one", status: "todo", pos: Date.now() } },
      { id: "op-offline-2", type: "card-create", cardId: "offline-card-2", ts: Date.now() + 10, client: "client-c", payload: { title: "Offline note two", status: "done", pos: Date.now() + 10 } }
    ];
    const c = await connect(`ws://127.0.0.1:${port}`);
    c.ws.send(JSON.stringify({ kind: "join", room: roomId, client: "client-c", name: "Offline", color: "#f0b354" }));
    await waitMessage(c, (m) => m.kind === "joined");
    for (const op of offlineOps) c.ws.send(JSON.stringify({ kind: "op", room: roomId, op }));
    await waitFor(() => c.messages.filter((m) => m.kind === "op-ack" && m.applied).length >= 2, 4000, "op acks");
    const afterOffline = await (await fetch(`${base}/api/rooms/${roomId}`)).json();
    ok("offline queue replayed into the board", afterOffline.cards.length === 3, `${afterOffline.cards.length} cards`);
    c.ws.close();

    // ---- live cursors
    b.messages.length = 0;
    a.ws.send(JSON.stringify({ kind: "cursor", room: roomId, x: 420, y: 180 }));
    const cursorMsg = await waitMessage(b, (m) => m.kind === "cursor");
    ok("live cursor relayed to the other client", cursorMsg.x === 420 && cursorMsg.name === "Alex");

    // ---- history reconstruction
    const cut = Date.now() - 30000; // 30s ago: before offline cards were added
    const hist = await (await fetch(`${base}/api/rooms/${roomId}/history?t=${cut}`)).json();
    ok("history before the card existed is empty", hist.cards.length === 0, `${hist.cards.length} card(s) 30s ago`);

    const futureHist = await (await fetch(`${base}/api/rooms/${roomId}/history?t=${Date.now() + 5000}`)).json();
    ok("history at now includes everything", futureHist.cards.length === 3);

    // ---- delete
    const deleteOp = { id: "op-del-1", type: "card-delete", cardId: "offline-card-2", ts: Date.now() + 5000, client: "client-a", payload: {} };
    await post(`${base}/api/rooms/${roomId}/ops`, { op: deleteOp });
    const afterDelete = await (await fetch(`${base}/api/rooms/${roomId}`)).json();
    ok("delete removes card from the board", afterDelete.cards.length === 2);

    const histAfterDelete = await (await fetch(`${base}/api/rooms/${roomId}/history?t=${Date.now() + 4000}`)).json();
    ok("deleted card still exists in past history", histAfterDelete.cards.some((c) => c.id === "offline-card-2"));

    // ---- validation
    const emptyCard = await post(`${base}/api/rooms/${roomId}/cards`, { title: "" });
    ok("empty card title rejected", emptyCard.status === 400);

    const badOp = await post(`${base}/api/rooms/${roomId}/ops`, { op: { nope: true } });
    ok("malformed op rejected", badOp.status === 400);

    console.log("");
    if (failures === 0) {
      exitCode = 0;
      console.log("== selftest PASSED — PulseBoard is fully operational ◉ ==");
    } else {
      console.log(`== selftest FAILED — ${failures} assertion(s) failed ==`);
      exitCode = 1;
    }
  } catch (err) {
    console.log("\n== selftest FAILED (crash) ==\n" + err.message);
    exitCode = 1;
  } finally {
    try { a && a.ws.close(); } catch { /* ignore */ }
    try { b && b.ws.close(); } catch { /* ignore */ }
    try { app.kill(); } catch { /* ignore */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(exitCode);
}

main();
