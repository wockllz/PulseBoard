"use strict";
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const db = require("./src/db");

const app = express();
const PORT = process.env.PORT || 4600;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ------------------------------------------------------------------- pages */
app.get("/", (req, res) => res.render("index"));

/* --------------------------------------------------------------------- api */
app.get("/api/health", (req, res) => res.json({ ok: true, name: "PulseBoard" }));

app.get("/api/rooms", (req, res) => res.json({ rooms: db.listRooms() }));

app.post("/api/rooms", (req, res) => {
  const name = String((req.body && req.body.name) || "").trim();
  if (!name) return res.status(400).json({ error: "Room name required." });
  res.status(201).json({ room: db.createRoom(name.slice(0, 80)) });
});

app.delete("/api/rooms/:id", (req, res) => {
  if (!db.getRoom(req.params.id)) return res.status(404).json({ error: "Room not found." });
  db.deleteRoom(req.params.id);
  res.json({ ok: true });
});

app.get("/api/rooms/:id", (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found." });
  res.json({ room, cards: db.listCards(room.id), ops: db.opCount(room.id) });
});

app.post("/api/rooms/:id/cards", (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found." });
  const title = String((req.body && req.body.title) || "").trim();
  if (!title) return res.status(400).json({ error: "Card title required." });

  const op = {
    id: db.uid(),
    type: "card-create",
    cardId: db.uid(),
    ts: Date.now(),
    client: "api",
    payload: {
      title: title.slice(0, 200),
      detail: String(req.body.detail || "").slice(0, 4000),
      status: db.STATUSES.includes(req.body.status) ? req.body.status : "todo",
      pos: Number(req.body.pos) || Date.now()
    }
  };
  const result = db.applyOp(room.id, op);
  broadcastOp(room.id, op, result.card);
  res.status(201).json({ op, card: result.card });
});

app.post("/api/rooms/:id/ops", (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found." });
  const op = (req.body && req.body.op) || req.body;
  if (!op || !op.type || !op.id) return res.status(400).json({ error: "Malformed operation." });

  const result = db.applyOp(room.id, op);
  if (result.applied) broadcastOp(room.id, op, result.card);
  res.json({ applied: result.applied, duplicate: result.duplicate, card: result.card });
});

app.get("/api/rooms/:id/history", (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found." });
  const when = Number(req.query.t) || Date.now();
  res.json({ at: when, cards: db.stateAt(room.id, when), ops: db.opCount(room.id) });
});

/* ------------------------------------------------------------------ socket */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** roomId -> Map<ws, {name, color, cursor}> */
const rooms = new Map();

function presenceList(roomId) {
  const set = rooms.get(roomId);
  if (!set) return [];
  return [...set.entries()].map(([ws, p]) => ({ client: ws.clientId, name: p.name, color: p.color, cursor: p.cursor || null }));
}

function broadcast(roomId, payload, skipWs) {
  const set = rooms.get(roomId);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const ws of set.keys()) {
    if (ws !== skipWs && ws.readyState === 1) ws.send(msg);
  }
}

function broadcastOp(roomId, op, card) {
  broadcast(roomId, { kind: "op", op, card });
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || !msg.kind) return;

    if (msg.kind === "join") {
      const room = db.getRoom(msg.room);
      if (!room) { ws.send(JSON.stringify({ kind: "error", message: "Room not found" })); return; }

      // leave any previous room
      for (const [roomId, set] of rooms.entries()) {
        if (set.has(ws)) {
          set.delete(ws);
          broadcast(roomId, { kind: "presence", clients: presenceList(roomId) });
        }
      }

      ws.clientId = msg.client || db.uid();
      if (!rooms.has(room.id)) rooms.set(room.id, new Map());
      rooms.get(room.id).set(ws, { name: String(msg.name || "Guest").slice(0, 24), color: msg.color || "#5eb8ff" });

      ws.send(JSON.stringify({
        kind: "joined",
        room: room.id,
        client: ws.clientId,
        cards: db.listCards(room.id),
        clients: presenceList(room.id)
      }));
      broadcast(room.id, { kind: "presence", clients: presenceList(room.id) }, ws);
      return;
    }

    if (msg.kind === "op") {
      const roomId = msg.room;
      if (!roomId || !rooms.get(roomId)?.has(ws)) return;
      try {
        const result = db.applyOp(roomId, msg.op);
        if (result.applied) broadcastOp(roomId, msg.op, result.card);
        ws.send(JSON.stringify({ kind: "op-ack", id: msg.op.id, applied: result.applied, duplicate: result.duplicate }));
      } catch (err) {
        ws.send(JSON.stringify({ kind: "error", message: err.message }));
      }
      return;
    }

    if (msg.kind === "cursor") {
      const roomId = msg.room;
      const entry = rooms.get(roomId)?.get(ws);
      if (!entry) return;
      entry.cursor = { x: Number(msg.x) || 0, y: Number(msg.y) || 0 };
      broadcast(roomId, { kind: "cursor", client: ws.clientId, name: entry.name, color: entry.color, x: entry.cursor.x, y: entry.cursor.y }, ws);
      return;
    }

    if (msg.kind === "sync") {
      const roomId = msg.room;
      if (!db.getRoom(roomId)) return;
      ws.send(JSON.stringify({ kind: "state", room: roomId, cards: db.listCards(roomId), clients: presenceList(roomId) }));
    }
  });

  ws.on("close", () => {
    for (const [roomId, set] of rooms.entries()) {
      if (set.has(ws)) {
        set.delete(ws);
        broadcast(roomId, { kind: "presence", clients: presenceList(roomId) });
        if (!set.size) rooms.delete(roomId);
      }
    }
  });
});

// keepalive so dead sockets get cleaned up
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);
heartbeat.unref();

// make sure a default room exists so the app is never empty on first run
if (!db.listRooms().length) db.createRoom("Launch Board");

server.listen(PORT, () => {
  console.log(`\n◉ PulseBoard running on http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}\n`);
});
