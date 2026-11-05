# ◉ PulseBoard

**A real-time collaborative board that never loses an edit.** Multiple people, same board, live cursors, and a time machine you can scrub. Built on an operation log, so reconnects and conflicts are handled properly instead of "last save wins and hope".

![tests](https://img.shields.io/badge/tests-25%20passing-brightgreen) ![license](https://img.shields.io/badge/license-MIT-blue)

## What it actually does

- **Live sync** — every change is an operation sent over WebSocket and broadcast to everyone in the room.
- **Conflict handling** — last-write-wins by timestamp per card, so two people editing the same card never corrupt each other.
- **Idempotent replay** — every op has a unique client-generated id. Send it twice, nothing duplicates.
- **Offline queue** — lose connection, keep working. Your ops queue locally and flush on reconnect.
- **Presence + live cursors** — see who's in the room and where their pointer is, right now.
- **History scrubbing** — drag the slider and the board rebuilds itself from the op log at that exact moment. Deleted cards come back when you scrub into the past.

## Quick start

```bash
npm install
npm start
# → http://localhost:4600
```

Open the same URL in two browser windows — two people, one board, live.

## Run the test suite

```bash
npm run selftest
```

25 end-to-end assertions with **real WebSocket clients**: join/presence, broadcast to multiple clients, A→B move sync, duplicate-op rejection, last-write-wins (stale update ignored, newer update wins), offline queue replay, live cursor relay, history snapshots (before/after a card existed, deleted cards still visible in the past), and validation errors.

## How the sync model works

```
client op ──► validate ──► dedupe by op id ──► LWW apply (ts) ──► append op log ──► broadcast
                                                                        │
                                                            history = replay ≤ t
```

- **Cards** hold current state (`updated_at` = winning timestamp).
- **Ops** are append-only; nothing is ever mutated in the log.
- **History** is a pure function of the log: `stateAt(t)` replays every op up to `t`.
- Only `card-create` can create a card, so a stale update can never resurrect a deleted one.

## API + socket protocol

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/rooms` | list rooms |
| POST | `/api/rooms` | create room |
| GET | `/api/rooms/:id` | room + cards + op count |
| POST | `/api/rooms/:id/cards` | quick card create |
| POST | `/api/rooms/:id/ops` | apply an op (idempotent) |
| GET | `/api/rooms/:id/history?t=` | board state at timestamp |

Socket messages: `join`, `op`, `cursor`, `sync` → `joined`, `state`, `op`, `op-ack`, `presence`, `cursor`, `error`.

## Project structure

```
server.js        Express + WebSocket server, presence, rooms
src/db.js        SQLite: cards, append-only op log, stateAt() replay
public/js/board.js  drag & drop, sync client, offline queue, cursors, history UI
tests/selftest.js   25-check end-to-end suite with two real clients
```

## Roadmap

- Rich text / markdown cards
- Per-user undo (revert own ops)
- Presence avatars with idle detection
- Room invitations and permissions

MIT © Ntshuxeko Sambo
