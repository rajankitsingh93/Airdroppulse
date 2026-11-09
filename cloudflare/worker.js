import { DurableObject } from "cloudflare:workers";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_STORAGE_BYTES = 800 * 1024 * 1024;
const MAX_TRANSFERS_PER_ROOM = 100;
const ROOM_LIFETIME_MS = 60 * 60 * 1000;
const FILE_RETENTION_MS = 24 * 60 * 60 * 1000;
const CHUNK_BYTES = 256 * 1024;
const ROOM_PREFIX = "room:";
const TRANSFER_PREFIX = "transfer:";
const CHUNK_PREFIX = "chunk:";

function jsonResponse(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers
    }
  });
}

function securityHeaders(nonce = "") {
  const noncePolicy = nonce ? ` 'nonce-${nonce}'` : "";
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'self'; script-src 'self'${noncePolicy}; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`
  };
}

function safeFileName(value) {
  const name = value.replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180);
  return name && name !== "." && name !== ".." ? name : "dropped-file";
}

function randomCode() {
  const range = 900_000;
  const max = Math.floor(0x1_0000_0000 / range) * range;
  const sample = new Uint32Array(1);
  do {
    crypto.getRandomValues(sample);
  } while (sample[0] >= max);
  return String(100_000 + (sample[0] % range));
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function serveSite(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/robots.txt") {
    return new Response(`User-agent: *\nAllow: /\nSitemap: ${url.origin}/sitemap.xml\n`, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600", ...securityHeaders() }
    });
  }
  if (request.method === "GET" && url.pathname === "/sitemap.xml") {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${url.origin}/</loc></url>\n</urlset>\n`,
      { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600", ...securityHeaders() } }
    );
  }

  const assetResponse = await env.ASSETS.fetch(request);
  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    const headers = new Headers(assetResponse.headers);
    for (const [name, value] of Object.entries(securityHeaders())) {
      headers.set(name, value);
    }
    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers
    });
  }

  const nonce = randomNonce();
  const html = (await assetResponse.text())
    .replaceAll("__PUBLIC_ORIGIN__", url.origin)
    .replaceAll("__CSP_NONCE__", nonce);
  const headers = new Headers(assetResponse.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  for (const [name, value] of Object.entries(securityHeaders(nonce))) {
    headers.set(name, value);
  }
  return new Response(html, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) {
      const id = env.DROP_ROOM.idFromName("airdroppulse-global");
      return env.DROP_ROOM.get(id).fetch(request);
    }
    return serveSite(request, env);
  }
};

export class DropRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.activeUploadBytes = 0;
  }

  async ensureAlarm() {
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  getRoomSockets(code) {
    return this.ctx.getWebSockets().filter((socket) => {
      try {
        return socket.deserializeAttachment()?.code === code;
      } catch {
        return false;
      }
    });
  }

  send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  notifyRoom(code, message) {
    for (const socket of this.getRoomSockets(code)) this.send(socket, message);
  }

  async fetch(request) {
    await this.ensureAlarm();
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return jsonResponse(426, { error: "A WebSocket connection is required." });
      }
      if (!isSameOrigin(request)) return jsonResponse(403, { error: "Cross-origin connections are not allowed." });

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        code: null,
        address: request.headers.get("CF-Connecting-IP") || "unknown"
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResponse(200, {
        ok: true,
        maxFileBytes: MAX_FILE_BYTES,
        maxStorageBytes: MAX_STORAGE_BYTES,
        retentionHours: FILE_RETENTION_MS / (60 * 60 * 1000)
      });
    }
    if (request.method === "POST" && url.pathname === "/api/transfers") {
      return this.upload(request);
    }
    const transferMatch = url.pathname.match(/^\/api\/transfers\/([0-9a-f-]{36})$/i);
    if (transferMatch && request.method === "GET") return this.download(transferMatch[1]);
    if (transferMatch && request.method === "DELETE") return this.deleteTransfer(transferMatch[1]);
    return jsonResponse(404, { error: "Not found." });
  }

  async webSocketMessage(socket, rawMessage) {
    let message;
    try {
      const text = typeof rawMessage === "string"
        ? rawMessage
        : new TextDecoder().decode(rawMessage);
      message = JSON.parse(text);
    } catch {
      this.send(socket, { type: "error", message: "That request could not be understood." });
      return;
    }

    const attachment = socket.deserializeAttachment() || {};
    if (message.type === "create") {
      if (attachment.code) {
        this.send(socket, { type: "error", message: "This device already has an active drop." });
        return;
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const code = randomCode();
        const created = await this.ctx.storage.transaction(async (transaction) => {
          const existing = await transaction.get(`${ROOM_PREFIX}${code}`);
          if (existing && existing.expiresAt > Date.now()) return false;
          await transaction.put(`${ROOM_PREFIX}${code}`, {
            code,
            expiresAt: Date.now() + ROOM_LIFETIME_MS,
            transferIds: []
          });
          return true;
        });
        if (!created) continue;

        socket.serializeAttachment({ ...attachment, code });
        this.send(socket, { type: "room-created", code });
        return;
      }
      this.send(socket, { type: "error", message: "Could not create a drop right now. Please try again." });
      return;
    }

    if (message.type === "join") {
      if (attachment.code) {
        this.send(socket, { type: "error", message: "This device already has an active drop." });
        return;
      }
      if (!await this.consumeJoinAttempt(attachment.address || "unknown")) {
        this.send(socket, { type: "error", message: "Too many code attempts. Try again in a minute." });
        return;
      }
      const code = typeof message.code === "string" ? message.code.trim() : "";
      const room = /^\d{6}$/.test(code)
        ? await this.ctx.storage.get(`${ROOM_PREFIX}${code}`)
        : undefined;
      const clients = room ? this.getRoomSockets(code) : [];
      if (!room || room.expiresAt <= Date.now() || clients.length >= 2) {
        this.send(socket, { type: "error", message: "That code is unavailable. Check it and try again." });
        return;
      }

      socket.serializeAttachment({ ...attachment, code });
      this.send(socket, { type: "room-joined", code });
      for (const client of [...clients, socket]) {
        this.send(client, { type: "paired", count: clients.length + 1 });
      }
      return;
    }

    this.send(socket, { type: "error", message: "Unknown request." });
  }

  async consumeJoinAttempt(address) {
    const now = Date.now();
    const key = `attempt:${address}`;
    const attempts = (await this.ctx.storage.get(key) || []).filter((time) => now - time < 60_000);
    if (attempts.length >= 8) {
      await this.ctx.storage.put(key, attempts);
      return false;
    }
    attempts.push(now);
    await this.ctx.storage.put(key, attempts);
    return true;
  }

  async webSocketClose(socket) {
    const { code } = socket.deserializeAttachment() || {};
    if (code) this.notifyRoom(code, { type: "peer-disconnected" });
  }

  async webSocketError(socket) {
    const { code } = socket.deserializeAttachment() || {};
    if (code) this.notifyRoom(code, { type: "peer-disconnected" });
  }

  async upload(request) {
    const code = request.headers.get("X-Pair-Code");
    const room = code ? await this.ctx.storage.get(`${ROOM_PREFIX}${code}`) : undefined;
    if (
      !room ||
      room.expiresAt <= Date.now() ||
      this.getRoomSockets(code).length !== 2
    ) {
      return jsonResponse(403, { error: "Connect both devices with a valid code first." });
    }
    if (room.transferIds.length >= MAX_TRANSFERS_PER_ROOM) {
      return jsonResponse(429, { error: "This drop has reached its 100-item limit. Start a new drop to continue." });
    }

    const declaredLength = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES) {
      return jsonResponse(413, { error: "That item is larger than the 50 MB limit." });
    }
    let fileName;
    try {
      fileName = safeFileName(decodeURIComponent(request.headers.get("X-File-Name") || ""));
    } catch {
      return jsonResponse(400, { error: "The file name is invalid." });
    }
    if (!request.body || !fileName) return jsonResponse(400, { error: "A file name and file are required." });

    const transferId = crypto.randomUUID();
    const reader = request.body.getReader();
    let size = 0;
    let chunkCount = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > MAX_FILE_BYTES) {
          throw Object.assign(new Error("That item is larger than the 50 MB limit."), { status: 413 });
        }
        const storedBytes = Number(await this.ctx.storage.get("stored-bytes") || 0);
        if (storedBytes + this.activeUploadBytes + value.byteLength > MAX_STORAGE_BYTES) {
          throw Object.assign(new Error("Airdroppulse storage is full. Try again after older files expire."), { status: 507 });
        }
        this.activeUploadBytes += value.byteLength;
        size += value.byteLength;
        for (let offset = 0; offset < value.byteLength; offset += CHUNK_BYTES) {
          const chunk = value.slice(offset, Math.min(offset + CHUNK_BYTES, value.byteLength));
          await this.ctx.storage.put(`${CHUNK_PREFIX}${transferId}:${chunkCount}`, chunk);
          chunkCount += 1;
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      await this.deleteChunks(transferId, chunkCount);
      this.activeUploadBytes = Math.max(0, this.activeUploadBytes - size);
      if (error.status) return jsonResponse(error.status, { error: error.message });
      console.error("Could not save an incoming item:", error);
      return jsonResponse(500, { error: "The item could not be saved." });
    }

    const contentType = (request.headers.get("Content-Type") || "application/octet-stream").slice(0, 120);
    const transfer = {
      transferId,
      roomCode: code,
      fileName,
      size,
      contentType,
      expiresAt: Date.now() + FILE_RETENTION_MS,
      chunkCount
    };
    try {
      await this.ctx.storage.transaction(async (transaction) => {
        const currentRoom = await transaction.get(`${ROOM_PREFIX}${code}`);
        if (!currentRoom || currentRoom.expiresAt <= Date.now()) {
          throw new Error("This drop expired before the transfer finished.");
        }
        if (currentRoom.transferIds.length >= MAX_TRANSFERS_PER_ROOM) {
          throw new Error("This drop has reached its 100-item limit.");
        }
        currentRoom.transferIds.push(transferId);
        const total = Number(await transaction.get("stored-bytes") || 0);
        if (total + size > MAX_STORAGE_BYTES) throw new Error("Airdroppulse storage is full.");
        await transaction.put(`${ROOM_PREFIX}${code}`, currentRoom);
        await transaction.put(`${TRANSFER_PREFIX}${transferId}`, transfer);
        await transaction.put("stored-bytes", total + size);
      });
    } catch (error) {
      await this.deleteChunks(transferId, chunkCount);
      this.activeUploadBytes = Math.max(0, this.activeUploadBytes - size);
      if (error.message.includes("limit") || error.message.includes("full") || error.message.includes("expired")) {
        return jsonResponse(409, { error: error.message });
      }
      console.error("Could not save transfer metadata:", error);
      return jsonResponse(500, { error: "The item could not be saved." });
    }
    this.activeUploadBytes = Math.max(0, this.activeUploadBytes - size);
    this.notifyRoom(code, {
      type: "transfer-complete",
      transferId,
      fileName,
      size,
      contentType,
      expiresAt: transfer.expiresAt
    });
    return jsonResponse(201, { transferId, size });
  }

  async deleteChunks(transferId, chunkCount) {
    for (let start = 0; start < chunkCount; start += 100) {
      const keys = [];
      for (let index = start; index < Math.min(start + 100, chunkCount); index += 1) {
        keys.push(`${CHUNK_PREFIX}${transferId}:${index}`);
      }
      if (keys.length) await this.ctx.storage.delete(keys);
    }
  }

  async download(transferId) {
    const transfer = await this.ctx.storage.get(`${TRANSFER_PREFIX}${transferId}`);
    if (!transfer || transfer.expiresAt <= Date.now()) {
      return jsonResponse(404, { error: "This transfer is unavailable or has expired." });
    }

    const data = new Uint8Array(transfer.size);
    let offset = 0;
    for (let index = 0; index < transfer.chunkCount; index += 1) {
      const chunk = await this.ctx.storage.get(`${CHUNK_PREFIX}${transferId}:${index}`);
      if (!chunk) return jsonResponse(404, { error: "This transfer is no longer available." });
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return new Response(data, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(data.byteLength),
        "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(transfer.fileName)}`,
        "Cache-Control": "private, no-store",
        ...securityHeaders()
      }
    });
  }

  async deleteTransfer(transferId) {
    const key = `${TRANSFER_PREFIX}${transferId}`;
    const transfer = await this.ctx.storage.get(key);
    if (!transfer) return jsonResponse(200, { deleted: false });

    await this.deleteChunks(transferId, transfer.chunkCount);
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.delete(key);
      const total = Number(await transaction.get("stored-bytes") || 0);
      await transaction.put("stored-bytes", Math.max(0, total - transfer.size));
      const roomKey = `${ROOM_PREFIX}${transfer.roomCode}`;
      const room = await transaction.get(roomKey);
      if (room) {
        room.transferIds = room.transferIds.filter((id) => id !== transferId);
        await transaction.put(roomKey, room);
      }
    });
    this.notifyRoom(transfer.roomCode, { type: "transfer-deleted", transferId });
    return jsonResponse(200, { deleted: true });
  }

  async alarm() {
    const now = Date.now();
    const rooms = await this.ctx.storage.list({ prefix: ROOM_PREFIX });
    for (const [key, room] of rooms) {
      if (room.expiresAt > now) continue;
      for (const socket of this.getRoomSockets(room.code)) {
        this.send(socket, { type: "error", message: "This drop code expired. Create a new drop to continue." });
        socket.close(1000, "Drop expired");
      }
      await this.ctx.storage.delete(key);
    }

    const transfers = await this.ctx.storage.list({ prefix: TRANSFER_PREFIX });
    for (const [key, transfer] of transfers) {
      if (transfer.expiresAt > now) continue;
      await this.deleteTransfer(transfer.transferId);
    }

    const attempts = await this.ctx.storage.list({ prefix: "attempt:" });
    for (const [key, values] of attempts) {
      const active = values.filter((time) => now - time < 60_000);
      if (active.length) await this.ctx.storage.put(key, active);
      else await this.ctx.storage.delete(key);
    }
    await this.ctx.storage.setAlarm(now + 60_000);
  }
}
