const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_BYTES = 250 * 1024 * 1024;
const ROOM_LIFETIME_MS = 60 * 60 * 1000;
const APP_DIR = __dirname;
const RECEIVED_DIR = path.join(APP_DIR, "received");
const rooms = new Map();
const joinAttempts = new Map();

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
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function cleanFileName(value) {
  const withoutSeparators = value.replace(/[\\/]/g, "_");
  const name = path.basename(withoutSeparators)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180);
  return name && name !== "." && name !== ".." ? name : "dropped-file";
}

async function serveStatic(request, response) {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(APP_DIR, `.${requestedPath}`);

  if (!filePath.startsWith(`${APP_DIR}${path.sep}`)) {
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
      "X-Content-Type-Options": "nosniff"
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

  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES) {
    request.resume();
    jsonResponse(response, 413, { error: "That item is larger than the 250 MB limit." });
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
  const storedName = `${Date.now()}-${crypto.randomUUID()}-${safeName}`;
  const destinationPath = path.join(destinationDirectory, storedName);
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
      callback(null, chunk);
    }
  });

  try {
    await pipeline(request, sizeLimit, output);
  } catch (error) {
    await fs.promises.rm(destinationPath, { force: true });
    if (!response.headersSent) {
      const status = error.code === "LIMIT_EXCEEDED" ? 413 : 500;
      jsonResponse(response, status, {
        error: status === 413 ? "That item is larger than the 250 MB limit." : "The item could not be saved."
      });
    }
    if (statusForLog(error) === 500) {
      console.error("Could not save an incoming item:", error);
    }
    return;
  }

  const contentType = String(request.headers["content-type"] || "application/octet-stream")
    .slice(0, 120);
  const item = {
    type: "transfer-complete",
    fileName: safeName,
    size: bytesReceived,
    contentType,
    savedTo: path.join("received", dayFolder, storedName)
  };
  notifyRoom(room, item);
  jsonResponse(response, 201, { savedTo: item.savedTo, size: bytesReceived });
}

function statusForLog(error) {
  return error.code === "LIMIT_EXCEEDED" ? 413 : 500;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (request.method === "GET" && url.pathname === "/api/health") {
    jsonResponse(response, 200, { ok: true, maxFileBytes: MAX_FILE_BYTES });
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
  if (request.method !== "GET" && request.method !== "HEAD") {
    jsonResponse(response, 405, { error: "Method not allowed." });
    return;
  }
  await serveStatic(request, response);
});

const webSocketServer = new WebSocketServer({ server, path: "/ws", maxPayload: 2048 });

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
        expiresAt: Date.now() + ROOM_LIFETIME_MS
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
    if (room.clients.size === 0) {
      rooms.delete(room.code);
    } else {
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
  for (const [address, attempts] of joinAttempts) {
    if (!attempts.some((timestamp) => now - timestamp < 60_000)) {
      joinAttempts.delete(address);
    }
  }
}, 60_000);
cleanup.unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Airdroppulse is ready on http://localhost:${PORT}`);
  console.log("For phone access, use this computer's local network address and keep both devices on the same Wi-Fi.");
});
