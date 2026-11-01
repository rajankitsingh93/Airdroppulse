const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_BYTES = 250 * 1024 * 1024;
const MAX_TRANSFERS_PER_ROOM = 100;
const MAX_STORAGE_BYTES = Number(process.env.MAX_STORAGE_BYTES) || 800 * 1024 * 1024;
const FILE_RETENTION_MS = 24 * 60 * 60 * 1000;
const ROOM_LIFETIME_MS = 60 * 60 * 1000;
const APP_DIR = __dirname;
const RECEIVED_DIR = path.resolve(process.env.STORAGE_DIR || path.join(APP_DIR, "received"));
const rooms = new Map();
const transfers = new Map();
const orphanFiles = new Map();
const joinAttempts = new Map();
let storedBytes = 0;
let activeUploadBytes = 0;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function notifyRoom(room, message) {
  for (const socket of room.clients) {
    send(socket, message);
  }
}

function getRoom(code) {
  return rooms.get(code);
}

function makeCode() {
  let code;
  do {
    code = crypto.randomInt(100000, 1000000).toString();
  } while (rooms.has(code));
  return code;
}

function consumeJoinAttempt(address) {
  const now = Date.now();
  const recentAttempts = (joinAttempts.get(address) || []).filter(
    (timestamp) => now - timestamp < 60_000
  );
  if (recentAttempts.length >= 8) {
    joinAttempts.set(address, recentAttempts);
    return false;
  }
  recentAttempts.push(now);
  joinAttempts.set(address, recentAttempts);
  return true;
}

function jsonResponse(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  response.end(JSON.stringify(value));
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  };
}

function cleanFileName(value) {
  const withoutSeparators = value.replace(/[\\/]/g, "_");
  const name = path.basename(withoutSeparators)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180);
  return name && name !== "." && name !== ".." ? name : "dropped-file";
}

function isWithinDirectory(directory, candidate) {
  const relativePath = path.relative(directory, candidate);
  return relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

async function initializeStorage() {
  await fs.promises.mkdir(RECEIVED_DIR, { recursive: true });
  const now = Date.now();
  for (const dayEntry of await fs.promises.readdir(RECEIVED_DIR, { withFileTypes: true })) {
    if (!dayEntry.isDirectory()) continue;
    const dayPath = path.join(RECEIVED_DIR, dayEntry.name);
    for (const fileEntry of await fs.promises.readdir(dayPath, { withFileTypes: true })) {
      if (!fileEntry.isFile()) continue;
      const filePath = path.join(dayPath, fileEntry.name);
      const stat = await fs.promises.stat(filePath);
      if (fileEntry.name.endsWith(".json.tmp")) {
        await fs.promises.rm(filePath);
        continue;
      }
      if (now - stat.mtimeMs >= FILE_RETENTION_MS) {
        await fs.promises.rm(filePath);
        continue;
      }

      if (fileEntry.name.endsWith(".json")) {
        const transferId = fileEntry.name.slice(0, -5);
        const dataPath = path.join(dayPath, `${transferId}.data`);
        try {
          if (!/^[0-9a-f-]{36}$/i.test(transferId)) {
            throw new Error("Invalid transfer metadata filename.");
          }
          const metadata = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
          const dataStat = await fs.promises.stat(dataPath);
          if (
            typeof metadata.fileName !== "string" ||
            typeof metadata.contentType !== "string" ||
            typeof metadata.expiresAt !== "number" ||
            metadata.expiresAt <= now
          ) {
            await fs.promises.rm(dataPath, { force: true });
            await fs.promises.rm(filePath, { force: true });
            continue;
          }
          transfers.set(transferId, {
            transferId,
            filePath: dataPath,
            metadataPath: filePath,
            fileName: cleanFileName(metadata.fileName),
            size: dataStat.size,
            contentType: metadata.contentType.slice(0, 120),
            expiresAt: metadata.expiresAt
          });
          storedBytes += dataStat.size;
        } catch (error) {
          if (error.code !== "ENOENT") {
            console.error("Could not restore transfer metadata:", error);
          }
          await fs.promises.rm(dataPath, { force: true });
          await fs.promises.rm(filePath, { force: true });
        }
      } else if (fileEntry.name.endsWith(".data")) {
        const metadataPath = path.join(dayPath, `${fileEntry.name.slice(0, -5)}.json`);
        try {
          await fs.promises.access(metadataPath);
        } catch {
          await fs.promises.rm(filePath, { force: true });
        }
      } else {
        storedBytes += stat.size;
        orphanFiles.set(filePath, {
          size: stat.size,
          expiresAt: stat.mtimeMs + FILE_RETENTION_MS
        });
      }
    }
    if ((await fs.promises.readdir(dayPath)).length === 0) {
      await fs.promises.rmdir(dayPath);
    }
  }
}

async function serveStatic(request, response) {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(APP_DIR, `.${requestedPath}`);

  const receivedPath = path.resolve(RECEIVED_DIR);
  if (!isWithinDirectory(APP_DIR, filePath) || isWithinDirectory(receivedPath, filePath)) {
    jsonResponse(response, 404, { error: "Not found." });
    return;
  }

  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      jsonResponse(response, 404, { error: "Not found." });
      return;
    }

    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
      ...securityHeaders()
    });
    fs.createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error.code === "ENOENT") {
      jsonResponse(response, 404, { error: "Not found." });
      return;
    }
    console.error("Could not serve app file:", error);
    jsonResponse(response, 500, { error: "Could not load the app." });
  }
}

async function handleTransfer(request, response, url) {
  const code = request.headers["x-pair-code"];
  const room = typeof code === "string" ? getRoom(code) : undefined;
  if (!room || room.clients.size !== 2) {
    jsonResponse(response, 403, { error: "Connect both devices with a valid code first." });
    return;
  }
  if (room.transfers.size >= MAX_TRANSFERS_PER_ROOM) {
    request.resume();
    jsonResponse(response, 429, { error: "This drop has reached its 100-item limit. Start a new drop to continue." });
    return;
  }

  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES) {
    request.resume();
    jsonResponse(response, 413, { error: "That item is larger than the 250 MB limit." });
    return;
  }
  if (Number.isFinite(declaredLength) && storedBytes + activeUploadBytes + declaredLength > MAX_STORAGE_BYTES) {
    request.resume();
    jsonResponse(response, 507, { error: "Airdroppulse storage is full. Try again after older files expire." });
    return;
  }

  let originalName;
  try {
    originalName = decodeURIComponent(request.headers["x-file-name"] || "");
  } catch {
    request.resume();
    jsonResponse(response, 400, { error: "The file name is invalid." });
    return;
  }
  if (!originalName) {
    request.resume();
    jsonResponse(response, 400, { error: "A file name is required." });
    return;
  }

  const safeName = cleanFileName(originalName);
  const dayFolder = new Date().toISOString().slice(0, 10);
  const destinationDirectory = path.join(RECEIVED_DIR, dayFolder);
  await fs.promises.mkdir(destinationDirectory, { recursive: true });
  const transferId = crypto.randomUUID();
  const storedName = `${transferId}.data`;
  const destinationPath = path.join(destinationDirectory, storedName);
  const metadataPath = path.join(destinationDirectory, `${transferId}.json`);
  const output = fs.createWriteStream(destinationPath, { flags: "wx" });
  let bytesReceived = 0;
  const sizeLimit = new Transform({
    transform(chunk, encoding, callback) {
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_FILE_BYTES) {
        const error = new Error("File size limit exceeded.");
        error.code = "LIMIT_EXCEEDED";
        callback(error);
        return;
      }
      if (storedBytes + activeUploadBytes + chunk.length > MAX_STORAGE_BYTES) {
        bytesReceived -= chunk.length;
        const error = new Error("Storage limit exceeded.");
        error.code = "STORAGE_LIMIT_EXCEEDED";
        callback(error);
        return;
      }
      activeUploadBytes += chunk.length;
      callback(null, chunk);
    }
  });

  try {
    await pipeline(request, sizeLimit, output);
  } catch (error) {
    activeUploadBytes -= bytesReceived;
    await fs.promises.rm(destinationPath, { force: true });
    if (!response.headersSent) {
      const status = error.code === "LIMIT_EXCEEDED" ? 413 :
        error.code === "STORAGE_LIMIT_EXCEEDED" ? 507 : 500;
      jsonResponse(response, status, {
        error: status === 413 ? "That item is larger than the 250 MB limit." :
          status === 507 ? "Airdroppulse storage is full. Try again after older files expire." :
            "The item could not be saved."
      });
    }
    if (error.code !== "LIMIT_EXCEEDED" && error.code !== "STORAGE_LIMIT_EXCEEDED") {
      console.error("Could not save an incoming item:", error);
    }
    return;
  }
  activeUploadBytes -= bytesReceived;
  storedBytes += bytesReceived;

  const contentType = String(request.headers["content-type"] || "application/octet-stream")
    .slice(0, 120);
  const item = {
    type: "transfer-complete",
    transferId,
    fileName: safeName,
    size: bytesReceived,
    contentType,
    expiresAt: Date.now() + FILE_RETENTION_MS
  };
  try {
    const temporaryMetadataPath = `${metadataPath}.tmp`;
    await fs.promises.writeFile(temporaryMetadataPath, JSON.stringify({
      fileName: safeName,
      size: bytesReceived,
      contentType,
      expiresAt: item.expiresAt
    }), { flag: "wx" });
    await fs.promises.rename(temporaryMetadataPath, metadataPath);
  } catch (error) {
    storedBytes -= bytesReceived;
    await fs.promises.rm(destinationPath, { force: true });
    console.error("Could not save transfer metadata:", error);
    jsonResponse(response, 500, { error: "The item could not be saved." });
    return;
  }
  const storedTransfer = { filePath: destinationPath, metadataPath, ...item };
  transfers.set(transferId, storedTransfer);
  room.transfers.set(transferId, storedTransfer);
  notifyRoom(room, item);
  jsonResponse(response, 201, { transferId, size: bytesReceived });
}

async function handleDownload(response, transferId) {
  const transfer = transfers.get(transferId);
  if (!transfer || transfer.expiresAt <= Date.now()) {
    jsonResponse(response, 404, { error: "This transfer is unavailable or has expired." });
    return;
  }

  try {
    const stat = await fs.promises.stat(transfer.filePath);
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(transfer.fileName)}`,
      "Cache-Control": "private, no-store",
      ...securityHeaders()
    });
    await pipeline(fs.createReadStream(transfer.filePath), response);
  } catch (error) {
    if (error.code === "ENOENT") {
      jsonResponse(response, 404, { error: "This transfer is no longer available." });
      return;
    }
    if (!response.headersSent) {
      console.error("Could not download an incoming item:", error);
      jsonResponse(response, 500, { error: "This transfer could not be downloaded." });
    } else {
      response.destroy(error);
    }
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (request.method === "GET" && url.pathname === "/api/health") {
    jsonResponse(response, 200, {
      ok: true,
      maxFileBytes: MAX_FILE_BYTES,
      maxStorageBytes: MAX_STORAGE_BYTES,
      retentionHours: FILE_RETENTION_MS / (60 * 60 * 1000)
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/transfers") {
    try {
      await handleTransfer(request, response, url);
    } catch (error) {
      console.error("Transfer request failed:", error);
      if (!response.headersSent) {
        jsonResponse(response, 500, { error: "The item could not be saved." });
      }
    }
    return;
  }
  const downloadMatch = url.pathname.match(/^\/api\/transfers\/([0-9a-f-]{36})$/i);
  if (request.method === "GET" && downloadMatch) {
    await handleDownload(response, downloadMatch[1]);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    jsonResponse(response, 405, { error: "Method not allowed." });
    return;
  }
  await serveStatic(request, response);
});

const webSocketServer = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 2048,
  verifyClient: ({ origin, req }) => {
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }
});

webSocketServer.on("connection", (socket, request) => {
  socket.address = request.socket.remoteAddress || "unknown";
  socket.room = null;

  socket.on("message", (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      send(socket, { type: "error", message: "That request could not be understood." });
      return;
    }

    if (message.type === "create") {
      if (socket.room) {
        send(socket, { type: "error", message: "This device already has an active drop." });
        return;
      }
      const room = {
        code: makeCode(),
        clients: new Set([socket]),
        expiresAt: Date.now() + ROOM_LIFETIME_MS,
        transfers: new Map()
      };
      socket.room = room;
      rooms.set(room.code, room);
      send(socket, { type: "room-created", code: room.code });
      return;
    }

    if (message.type === "join") {
      if (socket.room) {
        send(socket, { type: "error", message: "This device already has an active drop." });
        return;
      }
      if (!consumeJoinAttempt(socket.address)) {
        send(socket, { type: "error", message: "Too many code attempts. Try again in a minute." });
        return;
      }
      const code = typeof message.code === "string" ? message.code.trim() : "";
      const room = /^\d{6}$/.test(code) ? getRoom(code) : undefined;
      if (!room || room.clients.size >= 2 || room.expiresAt < Date.now()) {
        send(socket, { type: "error", message: "That code is unavailable. Check it and try again." });
        return;
      }
      socket.room = room;
      room.clients.add(socket);
      send(socket, { type: "room-joined", code: room.code });
      for (const client of room.clients) {
        send(client, { type: "paired", count: room.clients.size });
      }
      return;
    }

    send(socket, { type: "error", message: "Unknown request." });
  });

  socket.on("close", () => {
    if (!socket.room) return;
    const room = socket.room;
    room.clients.delete(socket);
    if (room.clients.size > 0) {
      notifyRoom(room, { type: "peer-disconnected" });
    }
  });
});

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.expiresAt < now) {
      for (const socket of room.clients) {
        send(socket, { type: "error", message: "This drop code expired. Create a new drop to continue." });
        socket.close();
      }
      rooms.delete(code);
    }
  }
  for (const [transferId, transfer] of transfers) {
    if (transfer.expiresAt <= now) {
      transfers.delete(transferId);
      for (const room of rooms.values()) {
        room.transfers.delete(transferId);
      }
      storedBytes = Math.max(0, storedBytes - transfer.size);
      Promise.all([
        fs.promises.rm(transfer.filePath, { force: true }),
        fs.promises.rm(transfer.metadataPath, { force: true })
      ]).catch((error) => console.error("Could not remove an expired transfer:", error));
    }
  }
  for (const [filePath, file] of orphanFiles) {
    if (file.expiresAt <= now) {
      orphanFiles.delete(filePath);
      storedBytes = Math.max(0, storedBytes - file.size);
      fs.promises.rm(filePath, { force: true }).catch((error) => {
        console.error("Could not remove an expired stored file:", error);
      });
    }
  }
  for (const [address, attempts] of joinAttempts) {
    if (!attempts.some((timestamp) => now - timestamp < 60_000)) {
      joinAttempts.delete(address);
    }
  }
}, 60_000);
cleanup.unref();

initializeStorage().then(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Airdroppulse is ready on http://localhost:${PORT}`);
    console.log(`Transfers are kept for 24 hours; storage limit is ${MAX_STORAGE_BYTES} bytes.`);
  });
}).catch((error) => {
  console.error("Could not initialize Airdroppulse storage:", error);
  process.exitCode = 1;
});
