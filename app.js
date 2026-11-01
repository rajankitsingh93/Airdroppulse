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
const toast = document.querySelector("#toast");
const helpDialog = document.querySelector("#help-dialog");

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
    roomHint.textContent = "Open Airdroppulse on your other device and enter this code.";
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

function addActivity({ fileName, size, savedTo, contentType }) {
  document.querySelector("#empty-activity")?.remove();

  const item = document.createElement("article");
  item.className = "activity-item";
  const icon = document.createElement("div");
  icon.className = "activity-icon";
  icon.textContent = contentType.startsWith("image/") ? "▧" :
    contentType.startsWith("video/") ? "▷" :
    contentType.startsWith("text/") ? "≋" : "↗";
  const details = document.createElement("div");
  details.className = "activity-details";
  const name = document.createElement("div");
  name.className = "activity-name";
  name.textContent = fileName;
  const meta = document.createElement("div");
  meta.className = "activity-meta";
  meta.textContent = `${formatBytes(size)} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const saved = document.createElement("span");
  saved.className = "activity-saved";
  saved.textContent = "SAVED";
  saved.title = `Saved to ${savedTo}`;
  details.append(name, meta);
  item.append(icon, details, saved);
  activityList.prepend(item);
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
    showToast(`${message.fileName} saved on this computer.`);
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
  if (blob.size > 250 * 1024 * 1024) {
    showToast(`${fileName} is larger than the 250 MB limit.`);
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
