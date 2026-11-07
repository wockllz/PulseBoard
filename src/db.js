"use strict";
/**
 * PulseBoard storage: rooms, cards, and an append-only op log.
 *
 * Every mutation is an operation (card-create / card-update / card-delete).
 * Ops have unique ids (client generated) so replays are idempotent, and
 * timestamps so the history endpoint can rebuild any past state.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.PB_DATA_DIR || path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "pulseboard.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT DEFAULT '',
  status TEXT DEFAULT 'todo',
  pos REAL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by TEXT DEFAULT '',
  deleted INTEGER DEFAULT 0,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT DEFAULT 'application/octet-stream',
  size INTEGER DEFAULT 0,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ops (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  client TEXT DEFAULT '',
  type TEXT NOT NULL,
  card_id TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_room_ts ON ops(room_id, ts);
`);

const uid = () => crypto.randomUUID();
const STATUSES = ["todo", "doing", "done"];

/* ------------------------------------------------------------------- rooms */
function createRoom(name) {
  const id = uid();
  db.prepare("INSERT INTO rooms (id, name) VALUES (?, ?)").run(id, name);
  return getRoom(id);
}

function getRoom(id) {
  return db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) || null;
}

function listRooms() {
  return db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM cards c WHERE c.room_id = r.id AND c.deleted = 0) AS cards
       FROM rooms r ORDER BY r.created_at DESC`
    )
    .all();
}

function deleteRoom(id) {
  db.prepare("DELETE FROM ops WHERE room_id = ?").run(id);
  db.prepare("DELETE FROM cards WHERE room_id = ?").run(id);
  db.prepare("DELETE FROM rooms WHERE id = ?").run(id);
}

/* ------------------------------------------------------------------- cards */
function listCards(roomId) {
  return db
    .prepare("SELECT * FROM cards WHERE room_id = ? AND deleted = 0 ORDER BY pos ASC, updated_at ASC")
    .all(roomId);
}

function getCard(id) {
  return db.prepare("SELECT * FROM cards WHERE id = ?").get(id) || null;
}

/* --------------------------------------------------------------- op log */
function hasOp(id) {
  return !!db.prepare("SELECT id FROM ops WHERE id = ?").get(id);
}

/**
 * Apply an operation (idempotent, last-write-wins by ts) and log it.
 * Returns { applied, duplicate, card }.
 */
function applyOp(roomId, op) {
  if (!op || !op.id || !op.type) throw new Error("Malformed operation");
  if (hasOp(op.id)) return { applied: false, duplicate: true, card: op.cardId ? getCard(op.cardId) : null };

  const ts = Number(op.ts) || Date.now();
  const payload = op.payload || {};
  let card = op.cardId ? getCard(op.cardId) : null;
  let applied = false;

  db.prepare(
    "INSERT INTO ops (id, room_id, ts, client, type, card_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(op.id, roomId, ts, op.client || "", op.type, op.cardId || null, JSON.stringify(payload));

  if (op.type === "card-create") {
    if (!card) {
      const status = STATUSES.includes(payload.status) ? payload.status : "todo";
      db.prepare(
        `INSERT INTO cards (id, room_id, title, detail, status, pos, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        op.cardId || uid(),
        roomId,
        String(payload.title || "Untitled").slice(0, 200),
        String(payload.detail || "").slice(0, 4000),
        status,
        Number(payload.pos) || 0,
        ts,
        op.client || ""
      );
      applied = true;
    }
    card = op.cardId ? getCard(op.cardId) : null;
  } else if (op.type === "card-update" && card && ts >= card.updated_at) {
    const title = payload.title !== undefined ? String(payload.title).slice(0, 200) : card.title;
    const detail = payload.detail !== undefined ? String(payload.detail).slice(0, 4000) : card.detail;
    const status = payload.status !== undefined && STATUSES.includes(payload.status) ? payload.status : card.status;
    const pos = payload.pos !== undefined ? Number(payload.pos) : card.pos;
    db.prepare(
      "UPDATE cards SET title = ?, detail = ?, status = ?, pos = ?, updated_at = ?, updated_by = ? WHERE id = ?"
    ).run(title, detail, status, pos, ts, op.client || "", card.id);
    applied = true;
    card = getCard(card.id);
  } else if (op.type === "card-delete" && card && ts >= card.updated_at) {
    db.prepare("UPDATE cards SET deleted = 1, updated_at = ?, updated_by = ? WHERE id = ?").run(
      ts,
      op.client || "",
      card.id
    );
    applied = true;
    card = getCard(card.id);
  }

  return { applied, duplicate: false, card };
}

/* ---------------------------------------------------------------- history */
function stateAt(roomId, whenMs) {
  // Rebuild purely from the op log: only a card-create op can create a card.
  // Updates/deletes that reference a card outside their own timeline are ignored,
  // so a stale op can never resurrect a card that did not exist yet.
  const cards = new Map();

  const ops = db
    .prepare("SELECT * FROM ops WHERE room_id = ? AND ts <= ? ORDER BY ts ASC, id ASC")
    .all(roomId, Number(whenMs) || Date.now());

  for (const op of ops) {
    const payload = JSON.parse(op.payload || "{}");
    const cardId = op.card_id || op.cardId;
    if (!cardId) continue;
    const c = cards.get(cardId) || {
      id: cardId,
      room_id: roomId,
      title: "",
      detail: "",
      status: "todo",
      pos: 0,
      updated_at: 0,
      deleted: 1
    };
    if (op.type === "card-create") {
      cards.set(cardId, {
        ...c,
        title: String(payload.title || "Untitled"),
        detail: String(payload.detail || ""),
        status: STATUSES.includes(payload.status) ? payload.status : "todo",
        pos: Number(payload.pos) || 0,
        updated_at: op.ts,
        deleted: 0
      });
    } else if (op.type === "card-update" && cards.has(cardId) && op.ts >= c.updated_at) {
      cards.set(cardId, {
        ...c,
        title: payload.title !== undefined ? String(payload.title) : c.title,
        detail: payload.detail !== undefined ? String(payload.detail) : c.detail,
        status: payload.status !== undefined && STATUSES.includes(payload.status) ? payload.status : c.status,
        pos: payload.pos !== undefined ? Number(payload.pos) : c.pos,
        updated_at: op.ts,
        deleted: 0
      });
    } else if (op.type === "card-delete" && cards.has(cardId) && op.ts >= c.updated_at) {
      cards.set(cardId, { ...c, deleted: 1, updated_at: op.ts });
    }
  }

  return [...cards.values()]
    .filter((c) => !c.deleted)
    .sort((a, b) => a.pos - b.pos || a.updated_at - b.updated_at);
}

function opCount(roomId) {
  return db.prepare("SELECT COUNT(*) AS n FROM ops WHERE room_id = ?").get(roomId).n;
}

function addAttachment(a) {
  db.prepare(`INSERT INTO attachments (id, card_id, room_id, name, mime, size, path, created_at)
              VALUES (@id, @card_id, @room_id, @name, @mime, @size, @path, @created_at)`).run(a);
  return getAttachment(a.id);
}

function getAttachment(id) {
  return db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) || null;
}

function listAttachmentsForRoom(roomId) {
  return db.prepare("SELECT id, card_id, name, mime, size, created_at FROM attachments WHERE room_id = ? ORDER BY created_at ASC").all(roomId);
}

function deleteAttachment(id) {
  const row = getAttachment(id);
  db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  return row;
}

module.exports = {
  addAttachment, getAttachment, listAttachmentsForRoom, deleteAttachment,
  uid,
  createRoom,
  getRoom,
  listRooms,
  deleteRoom,
  listCards,
  getCard,
  applyOp,
  stateAt,
  opCount,
  STATUSES
};
