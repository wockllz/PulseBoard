"use strict";
/** PulseBoard client: WebSocket sync, presence, live cursors, offline queue, history. */
(function () {
  const $ = (id) => document.getElementById(id);
  const COLORS = ["#5eb8ff", "#55d6a0", "#f0b354", "#a78bff", "#ff8fc7", "#6de3e0", "#ff9d6b"];

  // crypto.randomUUID only exists in secure contexts (https / localhost).
  // Opened via a LAN IP it is missing, so fall back to a safe generator.
  const uid = () => {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
    } catch (_) { /* insecure context */ }
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  };

  const store = (window.localStorage.getItem("pb-name") || "").trim();
  const state = {
    roomId: null,
    clientId: uid(),
    name: store || "You",
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    cards: new Map(),
    files: new Map(),
    clients: [],
    ws: null,
    connected: false,
    queue: [],
    historyAt: null,
    lastCursorSent: 0,
    ops: 0
  };

  document.title = "PulseBoard — real-time collaborative board";
  $("my-name").value = state.name;
  $("you-dot").style.background = state.color;

  /* ------------------------------------------------------------------ utils */
  async function api(path, opts) {
    const res = await fetch(path, opts);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  const now = () => Date.now();
  const esc = (s) => String(s);

  function toast(msg) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2600);
  }

  /* ------------------------------------------------------------------ rooms */
  async function loadRooms(selectId) {
    const { body } = await api("/api/rooms");
    const select = $("room-select");
    select.innerHTML = "";
    for (const room of body.rooms || []) {
      const opt = document.createElement("option");
      opt.value = room.id;
      opt.textContent = `${room.name} (${room.cards})`;
      select.appendChild(opt);
    }
    const wanted = selectId || state.roomId || (body.rooms && body.rooms[0] && body.rooms[0].id);
    if (wanted) {
      select.value = wanted;
      if (wanted !== state.roomId) await joinRoom(wanted);
    }
  }

  async function newRoom() {
    const name = (window.prompt("Room name?") || "").trim();
    if (!name) return;
    const { body } = await api("/api/rooms", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name })
    });
    if (body.room) await loadRooms(body.room.id);
  }

  /* ----------------------------------------------------------------- socket */
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}`);
    state.ws = ws;

    ws.addEventListener("open", () => {
      setConn("online", "live");
      if (state.roomId) sendJoin();
      flushQueue();
    });

    ws.addEventListener("close", () => {
      setConn("offline", "reconnecting…");
      setTimeout(connect, 1600);
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.kind === "joined") {
        state.cards = new Map((msg.cards || []).map((c) => [c.id, c]));
        state.clients = msg.clients || [];
        renderAll();
        return;
      }
      if (msg.kind === "state") {
        state.cards = new Map((msg.cards || []).map((c) => [c.id, c]));
        state.clients = msg.clients || [];
        renderAll();
        return;
      }
      if (msg.kind === "op") {
        applyRemoteOp(msg.op, msg.card);
        return;
      }
      if (msg.kind === "op-ack") {
        if (msg.applied) state.ops += 1;
        $("ops-count").textContent = `${state.ops} operations`;
        return;
      }
      if (msg.kind === "presence") {
        state.clients = msg.clients || [];
        renderPresence();
        return;
      }
      if (msg.kind === "attachment-added") {
        const list = state.files.get(msg.cardId) || [];
        list.push(msg.attachment);
        state.files.set(msg.cardId, list);
        renderAll();
        return;
      }
      if (msg.kind === "attachment-removed") {
        const list = (state.files.get(msg.cardId) || []).filter((a) => a.id !== msg.id);
        state.files.set(msg.cardId, list);
        renderAll();
        return;
      }
      if (msg.kind === "cursor") {
        renderCursor(msg);
        return;
      }
    });
  }

  function setConn(kind, label) {
    const el = $("conn");
    el.className = `conn ${kind}`;
    $("conn-text").textContent = label;
    state.connected = kind === "online";
  }

  function sendJoin() {
    state.ws && state.ws.readyState === 1 && state.ws.send(JSON.stringify({
      kind: "join", room: state.roomId, client: state.clientId, name: state.name, color: state.color
    }));
  }

  async function joinRoom(roomId) {
    state.roomId = roomId;
    const { body } = await api(`/api/rooms/${roomId}`);
    state.cards = new Map((body.cards || []).map((c) => [c.id, c]));
    state.files = new Map();
    for (const a of body.attachments || []) {
      const list = state.files.get(a.card_id) || [];
      list.push(a);
      state.files.set(a.card_id, list);
    }
    state.ops = body.ops || 0;
    $("ops-count").textContent = `${state.ops} operations`;
    exitHistory();
    renderAll();
    sendJoin();
  }

  /* -------------------------------------------------------------------- ops */
  function sendOp(op) {
    op.client = state.clientId;
    if (state.connected && state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ kind: "op", room: state.roomId, op }));
    } else {
      state.queue.push(op);
    }
    applyLocalOp(op);
  }

  function flushQueue() {
    if (!state.queue.length || !state.ws || state.ws.readyState !== 1) return;
    const pending = state.queue.splice(0);
    for (const op of pending) {
      state.ws.send(JSON.stringify({ kind: "op", room: state.roomId, op }));
    }
  }

  function applyLocalOp(op) {
    if (op.type === "card-create") {
      state.cards.set(op.cardId, {
        id: op.cardId, room_id: state.roomId,
        title: op.payload.title, detail: op.payload.detail || "",
        status: op.payload.status || "todo", pos: op.payload.pos || now(),
        updated_at: op.ts, updated_by: op.client, deleted: 0
      });
    } else if (op.type === "card-update") {
      const card = state.cards.get(op.cardId);
      if (card) {
        const next = { ...card, ...op.payload, updated_at: op.ts, updated_by: op.client };
        if (op.payload.pos === undefined) next.pos = card.pos;
        state.cards.set(op.cardId, next);
      }
    } else if (op.type === "card-delete") {
      state.cards.delete(op.cardId);
    }
    renderAll();
  }

  function applyRemoteOp(op, card) {
    if (op.type === "card-delete") {
      state.cards.delete(op.cardId);
    } else if (card) {
      const current = state.cards.get(card.id);
      if (!current || card.updated_at >= current.updated_at) state.cards.set(card.id, card);
    }
    state.ops += 1;
    $("ops-count").textContent = `${state.ops} operations`;
    renderAll();
  }

  /* ----------------------------------------------------------------- render */
  function renderAll() {
    for (const status of ["todo", "doing", "done"]) {
      const container = document.querySelector(`[data-cards="${status}"]`);
      container.innerHTML = "";
      const cards = [...state.cards.values()]
        .filter((c) => c.status === status && !c.deleted)
        .sort((a, b) => (a.pos || 0) - (b.pos || 0));

      document.querySelector(`[data-count="${status}"]`).textContent = cards.length;

      if (!cards.length) {
        const empty = document.createElement("div");
        empty.className = "empty-col";
        empty.textContent = "drop cards here";
        container.appendChild(empty);
      }

      for (const card of cards) container.appendChild(renderCard(card));
    }
    renderPresence();
  }

  function renderCard(card) {
    const el = document.createElement("div");
    el.className = "card" + (state.historyAt ? " ghost-card" : "");
    el.draggable = !state.historyAt;
    el.dataset.id = card.id;

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = esc(card.title);
    el.appendChild(title);

    // detail text (if any)
    if (card.detail && card.detail.trim()) {
      const det = document.createElement("div");
      det.className = "card-detail";
      det.textContent = esc(card.detail);
      el.appendChild(det);
    }

    // attachments
    const files = state.files.get(card.id) || [];
    if (files.length) {
      const wrap = document.createElement("div");
      wrap.className = "card-files";
      for (const f of files) {
        const chip = document.createElement("a");
        chip.className = "chip";
        chip.href = `/files/${f.id}`;
        chip.target = "_blank";
        chip.rel = "noopener";
        chip.textContent = "📎 " + f.name;
        chip.title = `${Math.round((f.size || 0) / 1024)} KB`;
        wrap.appendChild(chip);
      }
      el.appendChild(wrap);
    }

    if (!state.historyAt) {
      const attach = document.createElement("button");
      attach.className = "card-attach";
      attach.type = "button";
      attach.title = "Attach a PDF or image";
      attach.textContent = "📎";
      attach.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".pdf,.png,.jpg,.jpeg,.txt,.md";
        input.addEventListener("change", async () => {
          const file = input.files && input.files[0];
          if (!file) return;
          attach.textContent = "…";
          const form = new FormData();
          form.append("file", file);
          const res = await fetch(`/api/cards/${card.id}/attachments`, { method: "POST", body: form });
          attach.textContent = "📎";
          if (!res.ok) {
            const b = await res.json().catch(() => ({}));
            toast(b.error || "Upload failed");
          }
        });
        input.click();
      });
      el.appendChild(attach);
    }

    const meta = document.createElement("div");
    meta.className = "card-meta";
    const who = document.createElement("span");
    who.textContent = card.updated_by ? (card.updated_by === state.clientId ? "you" : "peer") : "";
    const when = document.createElement("span");
    when.textContent = card.updated_at ? new Date(card.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    meta.appendChild(who);
    meta.appendChild(when);
    el.appendChild(meta);

    if (!state.historyAt) {
      const del = document.createElement("button");
      del.className = "card-del";
      del.type = "button";
      del.textContent = "✕";
      del.title = "Delete card";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        sendOp({ id: uid(), type: "card-delete", cardId: card.id, ts: now(), payload: {} });
      });
      el.appendChild(del);

      el.addEventListener("dblclick", () => startEdit(el, card));
      el.addEventListener("dragstart", (e) => {
        el.classList.add("dragging");
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => el.classList.remove("dragging"));
    }

    return el;
  }

  function startEdit(el, card) {
    const input = document.createElement("input");
    input.className = "card-edit";
    input.value = card.title;
    el.innerHTML = "";
    el.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const title = input.value.trim();
      if (title && title !== card.title) {
        sendOp({ id: uid(), type: "card-update", cardId: card.id, ts: now(), payload: { title } });
      } else {
        renderAll();
      }
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") renderAll();
    });
  }

  function renderPresence() {
    const wrap = $("presence");
    wrap.innerHTML = "";
    for (const client of state.clients) {
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.style.background = client.color || "#5eb8ff";
      avatar.textContent = String(client.name || "?").slice(0, 2).toUpperCase();
      avatar.title = client.name;
      wrap.appendChild(avatar);
    }
  }

  /* ---------------------------------------------------------------- cursors */
  const cursorEls = new Map();
  function renderCursor(msg) {
    let el = cursorEls.get(msg.client);
    if (!el) {
      el = document.createElement("div");
      el.className = "cursor";
      el.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 2l16 8-7 1-2 7z"/></svg>';
      const label = document.createElement("span");
      label.textContent = msg.name;
      label.style.background = msg.color;
      el.appendChild(label);
      el.firstChild.style.color = msg.color;
      $("cursors").appendChild(el);
      cursorEls.set(msg.client, el);
    }
    el.style.left = `${msg.x}px`;
    el.style.top = `${msg.y}px`;
    el.dataset.seen = String(now());
  }

  setInterval(() => {
    for (const [id, el] of cursorEls.entries()) {
      if (now() - Number(el.dataset.seen || 0) > 5000) {
        el.remove();
        cursorEls.delete(id);
      }
    }
  }, 2000);

  $("board").addEventListener("mousemove", (e) => {
    if (!state.connected || state.historyAt) return;
    const t = now();
    if (t - state.lastCursorSent < 45) return;
    state.lastCursorSent = t;
    const rect = $("board").getBoundingClientRect();
    state.ws.send(JSON.stringify({
      kind: "cursor", room: state.roomId, x: Math.round(e.clientX - rect.left), y: Math.round(e.clientY - rect.top)
    }));
  });

  /* --------------------------------------------------------------- dragging */
  for (const col of document.querySelectorAll(".col")) {
    const status = col.dataset.status;
    col.addEventListener("dragover", (e) => {
      if (state.historyAt) return;
      e.preventDefault();
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", (e) => {
      col.classList.remove("drag-over");
      if (state.historyAt) return;
      e.preventDefault();
      const cardId = e.dataTransfer.getData("text/plain");
      const card = state.cards.get(cardId);
      if (!card || card.status === status) return;
      sendOp({
        id: uid(), type: "card-update", cardId,
        ts: now(), payload: { status, pos: now() }
      });
    });
  }

  /* ------------------------------------------------------------- add cards */
  let composer = null;

  function closeComposer() {
    if (composer) { composer.remove(); composer = null; }
  }

  function openComposer(status) {
    closeComposer();
    const host = document.querySelector(`[data-cards="${status}"]`);
    if (!host) return;

    const box = document.createElement("div");
    box.className = "composer";
    box.innerHTML = `
      <input class="composer-input" placeholder="Card title…" maxlength="120" />
      <div class="composer-row">
        <button class="btn-mini primary" type="button">ADD</button>
        <button class="btn-mini" type="button">CANCEL</button>
      </div>`;
    host.prepend(box);
    composer = box;

    const input = box.querySelector(".composer-input");
    const [addBtn, cancelBtn] = box.querySelectorAll(".btn-mini");
    input.focus();

    const commit = async () => {
      const title = input.value.trim();
      if (!title) { input.focus(); return; }
      closeComposer();
      await createCard(title, status);
    };

    addBtn.addEventListener("click", commit);
    cancelBtn.addEventListener("click", closeComposer);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") closeComposer();
    });
  }

  async function createCard(title, status) {
    const op = {
      id: uid(), type: "card-create", cardId: uid(),
      ts: now(), payload: { title, status, pos: now() }
    };
    // optimistic apply so the card appears instantly
    applyLocalOp(op);
    render();

    if (state.connected && state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ kind: "op", room: state.roomId, op }));
    } else {
      // socket down: persist over HTTP so nothing is lost
      const res = await fetch(`/api/rooms/${state.roomId}/cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, status })
      });
      if (!res.ok) {
        toast("Could not save that card — check the connection.");
      }
    }
  }

  for (const btn of document.querySelectorAll("[data-add]")) {
    btn.addEventListener("click", () => {
      if (state.historyAt) return;
      openComposer(btn.dataset.add);
    });
  }

  /* --------------------------------------------------------------- history */
  const slider = $("time-travel");
  let historyTimer = null;

  slider.addEventListener("input", () => {
    const pct = Number(slider.value) / 100;
    const range = 10 * 60 * 1000; // last 10 minutes
    const at = now() - range + range * pct;
    if (pct > 0.985) { exitHistory(); return; }
    clearTimeout(historyTimer);
    historyTimer = setTimeout(async () => {
      const { body } = await api(`/api/rooms/${state.roomId}/history?t=${at}`);
      state.historyAt = at;
      state.cards = new Map((body.cards || []).map((c) => [c.id, c]));
      $("history-banner").classList.remove("hidden");
      $("history-exit").disabled = false;
      $("hist-label").textContent = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      renderAll();
    }, 180);
  });

  function exitHistory() {
    state.historyAt = null;
    $("history-banner").classList.add("hidden");
    $("history-exit").disabled = true;
    $("hist-label").textContent = "";
    slider.value = 100;
    if (state.roomId) {
      api(`/api/rooms/${state.roomId}`).then(({ body }) => {
        state.cards = new Map((body.cards || []).map((c) => [c.id, c]));
        renderAll();
      });
    }
  }
  $("history-exit").addEventListener("click", exitHistory);

  /* ------------------------------------------------------------------- name */
  $("my-name").addEventListener("input", (e) => {
    state.name = e.target.value.trim() || "You";
    window.localStorage.setItem("pb-name", state.name);
    sendJoin();
  });

  $("room-select").addEventListener("change", (e) => joinRoom(e.target.value));
  $("new-room").addEventListener("click", newRoom);

  /* ------------------------------------------------------------------- boot */
  connect();
  loadRooms();
})();
