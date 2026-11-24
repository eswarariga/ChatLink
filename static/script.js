const socket = io();
const $ = (id) => document.getElementById(id);

let myUsername = "";
let activePartner = "";
let onlineUsers = [];
let soundEnabled = true;
let typingTimer = null;
let toastTimer = null;

const loginScreen = $("loginScreen");
const app = $("app");
const contacts = $("contacts");
const messagesEl = $("messages");
const messageInput = $("messageInput");

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function playSound() {
  if (!soundEnabled) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.045, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.17);
    oscillator.onended = () => ctx.close();
  } catch (_) {}
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function timeLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function joinChat(name) {
  activePartner = name;
  $("welcomePanel").classList.add("hidden");
  $("conversation").classList.remove("hidden");
  $("chatTitle").textContent = name;
  $("chatSubtitle").textContent = onlineUsers.includes(name) ? "● Online · Private conversation" : "○ Offline · Messages are saved";
  $("chatAvatar").textContent = (name[0] || "?").toUpperCase();
  $("searchInput").disabled = false;
  messageInput.disabled = false;
  $("sendBtn").disabled = false;
  renderContacts();
  loadHistory(name);
  messageInput.focus();
}

function renderContacts() {
  const others = onlineUsers.filter(name => name !== myUsername);
  $("contactCount").textContent = others.length;
  if (!others.length) {
    contacts.innerHTML = '<div class="empty-contacts">No one else is online yet.<br>Ask a friend to join your Wi-Fi chat.</div>';
    return;
  }
  contacts.innerHTML = others.map(name => `
    <div class="contact ${activePartner === name ? "active" : ""}" data-name="${escapeHtml(name)}">
      <div class="avatar">${escapeHtml((name[0] || "?").toUpperCase())}</div>
      <div class="contact-copy"><strong>${escapeHtml(name)}</strong><small><i class="status-dot"></i> Online</small></div>
      <span class="contact-meta">●</span>
    </div>`).join("");
  contacts.querySelectorAll(".contact").forEach(el => {
    el.addEventListener("click", () => joinChat(el.dataset.name));
  });
}

async function loadHistory(partner) {
  messagesEl.innerHTML = '<div class="date-divider">Loading conversation…</div>';
  try {
    const response = await fetch(`/api/history?username=${encodeURIComponent(myUsername)}&partner=${encodeURIComponent(partner)}`);
    const data = await response.json();
    if (partner !== activePartner) return;
    messagesEl.innerHTML = "";
    data.messages.forEach(renderMessage);
    scrollToBottom();
    socket.emit("mark_read", { sender: partner });
  } catch (_) {
    messagesEl.innerHTML = '<div class="date-divider">Could not load chat history.</div>';
  }
}

function renderMessage(msg) {
  // Avoid duplicates when server sends to sender and recipient.
  if (document.querySelector(`[data-message-id="${msg.id}"]`)) return;
  const mine = msg.sender === myUsername;
  const row = document.createElement("div");
  row.className = `message-row ${mine ? "mine" : ""}`;
  row.dataset.messageId = msg.id;

  let content = `<div>${escapeHtml(msg.body || "").replace(/\n/g, "<br>")}</div>`;
  if (msg.file_url) {
    const isImage = (msg.file_type || "").startsWith("image/");
    const url = escapeHtml(msg.file_url);
    const name = escapeHtml(msg.file_name || "Shared file");
    content += isImage
      ? `<div class="file-card"><a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${name}"><br>${name}</a></div>`
      : `<div class="file-card"><span>📄</span><a href="${url}" target="_blank" rel="noopener" download="${name}">${name} · Download</a></div>`;
  }
  const tick = mine ? `<span class="ticks">${msg.read_at ? "✓✓ Read" : (onlineUsers.includes(msg.recipient) ? "✓✓ Delivered" : "✓ Sent")}</span>` : "";
  const reactions = (msg.reactions || []).map(r => `<span class="reaction">${escapeHtml(r.emoji)} ${escapeHtml(r.username)}</span>`).join("");
  row.innerHTML = `
    <div class="message-bubble">${content}
      <div class="message-meta">${mine ? "You" : escapeHtml(msg.sender)} · ${timeLabel(msg.created_at)} ${tick}</div>
    </div>
    <div class="reaction-list">${reactions}</div>
    <div class="react-tools">
      ${["👍","❤️","😂","😮","😢","🔥","👏","🎉"].map(e => `<button type="button" data-emoji="${e}" title="React ${e}">${e}</button>`).join("")}
    </div>`;
  row.querySelectorAll(".react-tools button").forEach(btn => {
    btn.addEventListener("click", () => socket.emit("add_reaction", { message_id: msg.id, emoji: btn.dataset.emoji }));
  });
  messagesEl.appendChild(row);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function sendMessage() {
  const body = messageInput.value.trim();
  if (!activePartner) return showToast("Choose a contact first.");
  if (!body) return;
  socket.emit("send_private", { recipient: activePartner, body });
  messageInput.value = "";
  socket.emit("stop_typing", { recipient: activePartner });
  messageInput.focus();
}

$("loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("usernameInput").value.trim();
  if (!name) return;
  myUsername = name;
  socket.emit("join", { username: name });
});

socket.on("join_success", ({ username }) => {
  myUsername = username;
  loginScreen.classList.add("hidden");
  app.classList.remove("hidden");
  $("myName").textContent = username;
  $("myAvatar").textContent = (username[0] || "?").toUpperCase();
  showToast(`Welcome, ${username}!`);
});

socket.on("join_error", data => showToast(data.message || "Could not join."));
socket.on("server_error", data => showToast(data.message || "Something went wrong."));

socket.on("presence_update", data => {
  const previous = onlineUsers.slice();
  onlineUsers = data.online_users || [];
  renderContacts();
  if (activePartner) {
    $("chatSubtitle").textContent = onlineUsers.includes(activePartner)
      ? "● Online · Private conversation"
      : "○ Offline · Messages are saved";
  }
  const cameOnline = onlineUsers.filter(n => !previous.includes(n) && n !== myUsername);
  cameOnline.forEach(n => showToast(`${n} is online`));
});

socket.on("new_message", msg => {
  const relevant = (msg.sender === myUsername && msg.recipient === activePartner) ||
                   (msg.sender === activePartner && msg.recipient === myUsername);
  if (relevant) {
    renderMessage(msg);
    scrollToBottom();
    if (msg.sender !== myUsername) {
      playSound();
      socket.emit("mark_read", { sender: msg.sender });
    }
  } else if (msg.sender !== myUsername) {
    playSound();
    showToast(`New message from ${msg.sender}`);
  }
});

socket.on("message_read", data => {
  const row = document.querySelector(`[data-message-id="${data.message_id}"]`);
  if (row) {
    const tick = row.querySelector(".ticks");
    if (tick) tick.textContent = "✓✓ Read";
  }
});

socket.on("messages_read", data => {
  (data.message_ids || []).forEach(id => {
    const row = document.querySelector(`[data-message-id="${id}"]`);
    const tick = row && row.querySelector(".ticks");
    if (tick) tick.textContent = "✓✓ Read";
  });
});

socket.on("reaction_update", data => {
  const row = document.querySelector(`[data-message-id="${data.message_id}"]`);
  if (!row) return;
  const list = row.querySelector(".reaction-list");
  const current = Array.from(list.querySelectorAll(".reaction")).map(el => el.textContent);
  const label = `${data.emoji} ${data.username}`;
  if (data.active && !current.includes(label)) {
    const span = document.createElement("span");
    span.className = "reaction";
    span.textContent = label;
    list.appendChild(span);
  } else if (!data.active) {
    Array.from(list.querySelectorAll(".reaction")).forEach(el => {
      if (el.textContent === label) el.remove();
    });
  }
});

socket.on("typing", data => {
  if (data.username === activePartner) $("typingIndicator").textContent = `${data.username} is typing…`;
});
socket.on("stop_typing", data => {
  if (data.username === activePartner) $("typingIndicator").textContent = "";
});

$("messageForm").addEventListener("submit", event => {
  event.preventDefault();
  sendMessage();
});

messageInput.addEventListener("input", () => {
  if (!activePartner) return;
  socket.emit("typing", { recipient: activePartner });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit("stop_typing", { recipient: activePartner }), 900);
});

$("emojiBtn").addEventListener("click", () => $("emojiPanel").classList.toggle("hidden"));
$("emojiPanel").querySelectorAll("button").forEach(btn => {
  btn.addEventListener("click", () => {
    messageInput.value += btn.textContent;
    messageInput.focus();
    $("emojiPanel").classList.add("hidden");
  });
});
document.addEventListener("click", event => {
  if (!event.target.closest("#emojiBtn") && !event.target.closest("#emojiPanel")) {
    $("emojiPanel").classList.add("hidden");
  }
});

$("fileInput").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !activePartner) return showToast("Choose a contact before sharing a file.");
  if (file.size > 10 * 1024 * 1024) return showToast("File is larger than 10 MB.");
  const form = new FormData();
  form.append("file", file);
  form.append("sender", myUsername);
  form.append("recipient", activePartner);
  try {
    const response = await fetch("/upload", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Upload failed.");
    showToast("File shared successfully.");
  } catch (error) {
    showToast(error.message || "Could not upload file.");
  }
});

$("searchInput").addEventListener("input", async event => {
  const q = event.target.value.trim();
  if (!q) return loadHistory(activePartner);
  if (!activePartner) return;
  try {
    const response = await fetch(`/api/search?username=${encodeURIComponent(myUsername)}&q=${encodeURIComponent(q)}`);
    const data = await response.json();
    messagesEl.innerHTML = "";
    const filtered = data.messages.filter(m =>
      (m.sender === activePartner && m.recipient === myUsername) ||
      (m.sender === myUsername && m.recipient === activePartner)
    );
    filtered.reverse().forEach(renderMessage);
    if (!filtered.length) messagesEl.innerHTML = '<div class="date-divider">No matching messages.</div>';
  } catch (_) {
    showToast("Search failed.");
  }
});

$("themeBtn").addEventListener("click", () => {
  document.body.classList.toggle("dark");
  localStorage.setItem("chatlink-theme", document.body.classList.contains("dark") ? "dark" : "light");
  $("themeBtn").textContent = document.body.classList.contains("dark") ? "☀️" : "🌙";
});
if (localStorage.getItem("chatlink-theme") === "dark") {
  document.body.classList.add("dark");
  $("themeBtn").textContent = "☀️";
}

$("soundBtn").addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  $("soundBtn").textContent = soundEnabled ? "🔔" : "🔕";
  showToast(soundEnabled ? "Notification sounds on" : "Notification sounds off");
});

$("leaveBtn").addEventListener("click", () => {
  location.reload();
});

window.addEventListener("beforeunload", () => {
  socket.disconnect();
});
