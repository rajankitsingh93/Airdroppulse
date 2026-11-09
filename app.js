const createButton = document.querySelector("#create-button");
const joinForm = document.querySelector("#join-form");
const codeInput = document.querySelector("#code-input");
const connectionActions = document.querySelector("#connection-actions");
const roomPanel = document.querySelector("#room-panel");
const roomCode = document.querySelector("#room-code");
const roomStatusText = document.querySelector("#room-status-text");
const roomHint = document.querySelector("#room-hint");
const copyButton = document.querySelector("#copy-button");
const newDropButton = document.querySelector("#new-drop-button");
const transferContent = document.querySelector("#transfer-content");
const transferDisabled = document.querySelector("#transfer-disabled");
const readyBadge = document.querySelector("#ready-badge");
const dropZone = document.querySelector("#drop-zone");
const fileInput = document.querySelector("#file-input");
const messageInput = document.querySelector("#message-input");
const sendMessageButton = document.querySelector("#send-message-button");
const activityList = document.querySelector("#activity-list");
const clearAllButton = document.querySelector("#clear-all-button");
const toast = document.querySelector("#toast");
const helpDialog = document.querySelector("#help-dialog");
const ACTIVITY_STORAGE_KEY = "airdroppulse.activity";
const MAX_FILE_BYTES = 50 * 1024 * 1024;

let socket;
let currentCode = "";
let paired = false;
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3100);
}

function setPaired(isPaired) {
  paired = isPaired;
  transferContent.classList.toggle("hidden", !paired);
  transferDisabled.classList.toggle("hidden", paired);
  transferContent.setAttribute("aria-disabled", String(!paired));
  readyBadge.classList.toggle("is-ready", paired);
  readyBadge.innerHTML = paired ? "<span></span> READY TO GO" : "<span></span> WAITING";
  if (paired) {
    roomStatusText.textContent = "Two devices connected";
    roomHint.textContent = "You're connected. Send something from either device.";
  } else if (currentCode) {
    roomStatusText.textContent = "Your drop is ready";
    roomHint.textContent = "On the receiving device, open this same website and enter the code.";
  }
  updateSendButton();
}

function showRoom(code) {
  currentCode = code;
  roomCode.textContent = code;
  connectionActions.classList.add("hidden");
  roomPanel.classList.remove("hidden");
  setPaired(false);
}

function clearRoom() {
  currentCode = "";
  setPaired(false);
  roomPanel.classList.add("hidden");
  connectionActions.classList.remove("hidden");
  roomCode.textContent = "------";
}

function addActivity({ transferId, fileName, size, contentType, expiresAt }, save = true) {
  if (activityList.querySelector(`[data-transfer-id="${CSS.escape(transferId)}"]`)) return;
  document.querySelector("#empty-activity")?.remove();

  const item = document.createElement("article");
  item.className = "activity-item";
  item.dataset.transferId = transferId;
  item.dataset.expiresAt = String(expiresAt);
  const icon = document.createElement("div");
  icon.className = "activity-icon";
  icon.textContent = contentType?.startsWith("image/") ? "▧" :
    contentType?.startsWith("video/") ? "▷" :
    contentType?.startsWith("text/") ? "≋" : "↗";
  const details = document.createElement("div");
  details.className = "activity-details";
  const name = document.createElement("div");
  name.className = "activity-name";
  name.textContent = fileName;
  const meta = document.createElement("div");
  meta.className = "activity-meta";
  meta.textContent = `${formatBytes(size)} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · stored up to 24h`;
  const download = document.createElement("button");
  download.className = "activity-download";
  download.type = "button";
  download.textContent = "Download";
  download.addEventListener("click", async () => {
    download.disabled = true;
    try {
      const response = await fetch(`/api/transfers/${encodeURIComponent(transferId)}`);
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "This transfer could not be downloaded.");
      }
      const file = await response.blob();
      const objectUrl = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = fileName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      showToast(`${fileName} downloaded.`);
    } catch (error) {
      showToast(error.message || `Could not download ${fileName}.`);
    } finally {
      download.disabled = false;
    }
  });
  const clear = document.createElement("button");
  clear.className = "activity-clear";
  clear.type = "button";
  clear.textContent = "Clear";
  clear.setAttribute("aria-label", `Clear ${fileName}`);
  clear.addEventListener("click", async () => {
    clear.disabled = true;
    try {
      await deleteActivityTransfer(transferId);
      showToast(`${fileName} was cleared.`);
    } catch (error) {
      clear.disabled = false;
      showToast(error.message || `Could not clear ${fileName}.`);
    }
  });
  const actions = document.createElement("div");
  actions.className = "activity-actions";
  actions.append(download, clear);
  details.append(name, meta);
  item.append(icon, details, actions);
  activityList.prepend(item);
  clearAllButton.disabled = false;
  if (save) rememberActivity({ transferId, fileName, size, contentType, expiresAt });
}

function removeActivity(transferId) {
  activityList.querySelector(`[data-transfer-id="${CSS.escape(transferId)}"]`)?.remove();
  try {
    const stored = JSON.parse(localStorage.getItem(ACTIVITY_STORAGE_KEY) || "[]");
    const active = Array.isArray(stored)
      ? stored.filter((item) => item?.transferId !== transferId && item?.expiresAt > Date.now())
      : [];
    localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(active));
  } catch {
    showToast("The file was cleared, but its recent entry couldn't be removed from this browser.");
  }
  if (!activityList.querySelector(".activity-item")) {
    showEmptyActivity();
  }
}

function showEmptyActivity() {
  if (activityList.querySelector(".activity-item")) return;
  const empty = document.createElement("div");
  empty.className = "empty-activity";
  empty.id = "empty-activity";
  for (const text of ["✳", "Dropped files show up here.", "Connect your devices to get started."]) {
    const span = document.createElement("span");
    span.textContent = text;
    if (text === "✳") span.className = "empty-icon";
    empty.append(span);
  }
  activityList.append(empty);
  clearAllButton.disabled = true;
}

async function deleteActivityTransfer(transferId) {
  const response = await fetch(`/api/transfers/${encodeURIComponent(transferId)}`, {
    method: "DELETE"
  });
  if (!response.ok) {
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("Airdroppulse couldn't clear this file.");
    }
    throw new Error(result.error || "Airdroppulse couldn't clear this file.");
  }
  removeActivity(transferId);
}

async function pruneExpiredActivity() {
  for (const item of activityList.querySelectorAll(".activity-item")) {
    if (Number(item.dataset.expiresAt) <= Date.now()) {
      removeActivity(item.dataset.transferId);
    }
  }
}

function rememberActivity(activity) {
  try {
    const stored = JSON.parse(localStorage.getItem(ACTIVITY_STORAGE_KEY) || "[]");
    const active = Array.isArray(stored)
      ? stored.filter((item) => item && typeof item.expiresAt === "number" && item.expiresAt > Date.now())
      : [];
    active.push(activity);
    localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(active.slice(-100)));
  } catch {
    showToast("Your browser couldn't save the recent-transfer list.");
  }
}

function restoreActivity() {
  try {
    const stored = JSON.parse(localStorage.getItem(ACTIVITY_STORAGE_KEY) || "[]");
    if (!Array.isArray(stored)) throw new Error("Recent transfers are invalid.");
    const active = stored.filter((item) =>
      item &&
      typeof item.transferId === "string" &&
      /^[0-9a-f-]{36}$/i.test(item.transferId) &&
      typeof item.fileName === "string" &&
      typeof item.size === "number" &&
      typeof item.expiresAt === "number" &&
      item.expiresAt > Date.now()
    ).slice(-100);
    for (const item of active) addActivity(item, false);
    localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(active));
  } catch {
    showToast("Recent transfers couldn't be restored in this browser.");
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return Promise.resolve(socket);
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect to Airdroppulse.")), { once: true });
    socket.addEventListener("message", handleSocketMessage);
    socket.addEventListener("close", () => {
      if (currentCode) {
        setPaired(false);
        roomStatusText.textContent = "Connection lost";
        showToast("Connection lost. Start a new drop to reconnect.");
      }
    });
  });
}

function handleSocketMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    showToast("The server sent an unreadable response.");
    return;
  }

  if (message.type === "room-created") {
    showRoom(message.code);
  } else if (message.type === "room-joined") {
    showRoom(message.code);
  } else if (message.type === "paired") {
    setPaired(message.count === 2);
    showToast("Your devices are connected.");
  } else if (message.type === "peer-disconnected") {
    setPaired(false);
    showToast("The other device disconnected.");
  } else if (message.type === "transfer-complete") {
    addActivity(message);
    showToast(`${message.fileName} is ready to download.`);
  } else if (message.type === "transfer-deleted") {
    removeActivity(message.transferId);
  } else if (message.type === "error") {
    createButton.disabled = false;
    showToast(message.message);
  }
}

createButton.addEventListener("click", async () => {
  createButton.disabled = true;
  try {
    const connection = await connect();
    connection.send(JSON.stringify({ type: "create" }));
  } catch (error) {
    createButton.disabled = false;
    showToast(error.message);
  }
});

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = codeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    showToast("Enter the 6-digit code shown on your other device.");
    return;
  }
  const joinButton = joinForm.querySelector("button");
  joinButton.disabled = true;
  try {
    const connection = await connect();
    connection.send(JSON.stringify({ type: "join", code }));
  } catch (error) {
    showToast(error.message);
  } finally {
    joinButton.disabled = false;
  }
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentCode);
    showToast("Drop code copied.");
  } catch {
    showToast("Select and copy the code manually.");
  }
});

newDropButton.addEventListener("click", () => {
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  socket = undefined;
  clearRoom();
  createButton.disabled = false;
});

function updateSendButton() {
  sendMessageButton.disabled = !paired || !messageInput.value.trim();
}

async function sendBlob(blob, fileName) {
  if (!paired || !currentCode) {
    showToast("Connect both devices before sending.");
    return false;
  }
  if (blob.size > MAX_FILE_BYTES) {
    showToast(`${fileName} is larger than the 50 MB limit.`);
    return false;
  }

  const encodedName = encodeURIComponent(fileName);
  try {
    const response = await fetch("/api/transfers", {
      method: "POST",
      headers: {
        "Content-Type": blob.type || "application/octet-stream",
        "X-File-Name": encodedName,
        "X-Pair-Code": currentCode
      },
      body: blob
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "This item could not be sent.");
    return true;
  } catch (error) {
    showToast(error.message || `Could not send ${fileName}.`);
    return false;
  }
}

async function sendFiles(files) {
  for (const file of files) {
    await sendBlob(file, file.name);
  }
}

dropZone.addEventListener("click", () => {
  if (paired) fileInput.click();
  else showToast("Connect both devices before sending.");
});
dropZone.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && paired) {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => {
  if (fileInput.files) sendFiles(fileInput.files);
  fileInput.value = "";
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (paired) dropZone.classList.add("drag-over");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-over");
  });
}
dropZone.addEventListener("drop", (event) => {
  if (!paired) {
    showToast("Connect both devices before sending.");
    return;
  }
  sendFiles(event.dataTransfer.files);
});

messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 100)}px`;
  updateSendButton();
});
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessageButton.click();
  }
});
sendMessageButton.addEventListener("click", async () => {
  const message = messageInput.value.trim();
  if (!message || !paired) return;
  sendMessageButton.disabled = true;
  const sent = await sendBlob(new Blob([message], { type: "text/plain;charset=utf-8" }), "note.txt");
  if (sent) {
    messageInput.value = "";
    messageInput.style.height = "auto";
  }
  updateSendButton();
});

document.querySelector("#help-button").addEventListener("click", () => helpDialog.showModal());
document.querySelector("#dialog-close").addEventListener("click", () => helpDialog.close());
document.querySelector("#dialog-ok").addEventListener("click", () => helpDialog.close());

clearAllButton.addEventListener("click", async () => {
  const items = [...activityList.querySelectorAll(".activity-item")];
  if (!items.length || !window.confirm(`Permanently delete ${items.length} stored ${items.length === 1 ? "file" : "files"}? Anyone with access to these drops will lose them.`)) {
    return;
  }

  clearAllButton.disabled = true;
  let cleared = 0;
  const failures = [];
  for (const item of items) {
    const clearButton = item.querySelector(".activity-clear");
    clearButton.disabled = true;
    try {
      await deleteActivityTransfer(item.dataset.transferId);
      cleared += 1;
    } catch (error) {
      failures.push(error.message);
      clearButton.disabled = false;
    }
  }
  if (failures.length) {
    clearAllButton.disabled = activityList.querySelectorAll(".activity-item").length === 0;
    showToast(`${cleared} cleared; ${failures.length} couldn't be cleared. ${failures[0]}`);
  } else {
    showToast(`${cleared} ${cleared === 1 ? "file" : "files"} cleared.`);
  }
});

restoreActivity();
window.setInterval(pruneExpiredActivity, 60_000);
