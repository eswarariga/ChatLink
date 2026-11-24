import os
import sqlite3
import uuid
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, join_room
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
DB_PATH = os.path.join(BASE_DIR, "chatlink.db")
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {
    "png", "jpg", "jpeg", "gif", "webp",
    "pdf", "txt", "doc", "docx", "xls", "xlsx",
    "ppt", "pptx", "zip", "csv"
}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("CHATLINK_SECRET", "change-this-for-your-own-network")
app.config["MAX_CONTENT_LENGTH"] = MAX_FILE_SIZE
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# username -> socket id (single active browser session per username)
online_users = {}
sid_to_username = {}


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender TEXT NOT NULL,
                recipient TEXT NOT NULL,
                body TEXT DEFAULT '',
                file_name TEXT,
                file_url TEXT,
                file_type TEXT,
                created_at TEXT NOT NULL,
                read_at TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS reactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                emoji TEXT NOT NULL,
                UNIQUE(message_id, username, emoji)
            )
        """)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def message_dict(row):
    return {
        "id": row["id"],
        "sender": row["sender"],
        "recipient": row["recipient"],
        "body": row["body"] or "",
        "file_name": row["file_name"],
        "file_url": row["file_url"],
        "file_type": row["file_type"],
        "created_at": row["created_at"],
        "read_at": row["read_at"],
        "reactions": []
    }


def add_reactions(messages):
    if not messages:
        return messages
    ids = [m["id"] for m in messages]
    marks = ",".join("?" for _ in ids)
    with db() as conn:
        rows = conn.execute(
            f"SELECT message_id, username, emoji FROM reactions WHERE message_id IN ({marks})",
            ids
        ).fetchall()
    grouped = {}
    for row in rows:
        grouped.setdefault(row["message_id"], []).append({
            "username": row["username"], "emoji": row["emoji"]
        })
    for msg in messages:
        msg["reactions"] = grouped.get(msg["id"], [])
    return messages


def emit_presence():
    users = sorted(online_users.keys(), key=str.lower)
    socketio.emit("presence_update", {"online_users": users})


@app.route("/")
def index():
    return render_template("index.html")


@app.get("/api/history")
def history():
    username = request.args.get("username", "").strip()
    partner = request.args.get("partner", "").strip()
    if not username or not partner:
        return jsonify({"messages": []}), 400

    with db() as conn:
        rows = conn.execute("""
            SELECT * FROM messages
            WHERE (sender = ? AND recipient = ?)
               OR (sender = ? AND recipient = ?)
            ORDER BY id ASC
            LIMIT 500
        """, (username, partner, partner, username)).fetchall()
    messages = [message_dict(r) for r in rows]
    return jsonify({"messages": add_reactions(messages)})


@app.get("/api/search")
def search():
    username = request.args.get("username", "").strip()
    q = request.args.get("q", "").strip()
    if not username or not q:
        return jsonify({"messages": []})
    pattern = f"%{q}%"
    with db() as conn:
        rows = conn.execute("""
            SELECT * FROM messages
            WHERE (sender = ? OR recipient = ?)
              AND body LIKE ?
            ORDER BY id DESC LIMIT 100
        """, (username, username, pattern)).fetchall()
    messages = [message_dict(r) for r in rows]
    return jsonify({"messages": add_reactions(messages)})


@app.post("/upload")
def upload():
    sender = request.form.get("sender", "").strip()
    recipient = request.form.get("recipient", "").strip()
    file = request.files.get("file")
    if not sender or not recipient or not file or not file.filename:
        return jsonify({"error": "Choose a file and a recipient."}), 400

    original = secure_filename(file.filename)
    if not original or "." not in original:
        return jsonify({"error": "This file type is not allowed."}), 400
    ext = original.rsplit(".", 1)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({"error": "Allowed: images, PDF, Office documents, TXT, CSV and ZIP."}), 400

    # Flask's MAX_CONTENT_LENGTH also limits request size.
    stored_name = f"{uuid.uuid4().hex}_{original}"
    file.save(os.path.join(UPLOAD_DIR, stored_name))
    file_url = f"/uploads/{stored_name}"
    file_type = file.mimetype or "application/octet-stream"
    created = now_iso()

    with db() as conn:
        cur = conn.execute("""
            INSERT INTO messages (sender, recipient, body, file_name, file_url, file_type, created_at)
            VALUES (?, ?, '', ?, ?, ?, ?)
        """, (sender, recipient, original, file_url, file_type, created))
        msg_id = cur.lastrowid
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (msg_id,)).fetchone()

    message = message_dict(row)
    message["reactions"] = []
    socketio.emit("new_message", message, room=f"user:{sender}")
    if recipient in online_users:
        socketio.emit("new_message", message, room=f"user:{recipient}")
    return jsonify({"ok": True, "message": message})


@app.get("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(UPLOAD_DIR, filename, as_attachment=False)


@socketio.on("connect")
def on_connect():
    emit("connected", {"ok": True})


@socketio.on("join")
def on_join(data):
    username = (data or {}).get("username", "").strip()
    if not username or len(username) > 24:
        emit("join_error", {"message": "Enter a username (1–24 characters)."})
        return

    # If the same name is already online, move that name to this new socket.
    old_sid = online_users.get(username)
    if old_sid and old_sid != request.sid:
        sid_to_username.pop(old_sid, None)

    online_users[username] = request.sid
    sid_to_username[request.sid] = username
    join_room(f"user:{username}")
    emit("join_success", {"username": username})
    emit_presence()


@socketio.on("send_private")
def on_send_private(data):
    sender = sid_to_username.get(request.sid)
    if not sender:
        emit("server_error", {"message": "Join ChatLink before sending messages."})
        return

    recipient = (data or {}).get("recipient", "").strip()
    body = (data or {}).get("body", "").strip()
    if not recipient or recipient == sender or not body or len(body) > 4000:
        emit("server_error", {"message": "Choose another user and enter a message (max 4000 characters)."})
        return

    created = now_iso()
    with db() as conn:
        cur = conn.execute("""
            INSERT INTO messages (sender, recipient, body, created_at)
            VALUES (?, ?, ?, ?)
        """, (sender, recipient, body, created))
        msg_id = cur.lastrowid
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (msg_id,)).fetchone()

    message = message_dict(row)
    message["reactions"] = []
    socketio.emit("new_message", message, room=f"user:{sender}")
    if recipient in online_users:
        socketio.emit("new_message", message, room=f"user:{recipient}")


@socketio.on("mark_read")
def on_mark_read(data):
    reader = sid_to_username.get(request.sid)
    sender = (data or {}).get("sender", "").strip()
    if not reader or not sender:
        return
    read_time = now_iso()
    with db() as conn:
        rows = conn.execute("""
            SELECT id FROM messages
            WHERE sender = ? AND recipient = ? AND read_at IS NULL
        """, (sender, reader)).fetchall()
        ids = [r["id"] for r in rows]
        conn.execute("""
            UPDATE messages SET read_at = ?
            WHERE sender = ? AND recipient = ? AND read_at IS NULL
        """, (read_time, sender, reader))
    if ids:
        socketio.emit("messages_read", {"message_ids": ids, "read_at": read_time, "reader": reader},
                      room=f"user:{sender}")


@socketio.on("add_reaction")
def on_add_reaction(data):
    username = sid_to_username.get(request.sid)
    if not username:
        return
    try:
        message_id = int((data or {}).get("message_id"))
    except (TypeError, ValueError):
        return
    emoji = (data or {}).get("emoji", "")
    if emoji not in {"👍", "❤️", "😂", "😮", "😢", "🔥", "👏", "🎉"}:
        return
    with db() as conn:
        row = conn.execute("SELECT sender, recipient FROM messages WHERE id = ?", (message_id,)).fetchone()
        if not row or username not in (row["sender"], row["recipient"]):
            return
        existing = conn.execute("""
            SELECT id FROM reactions WHERE message_id = ? AND username = ? AND emoji = ?
        """, (message_id, username, emoji)).fetchone()
        if existing:
            conn.execute("DELETE FROM reactions WHERE id = ?", (existing["id"],))
            active = False
        else:
            conn.execute("""
                INSERT OR IGNORE INTO reactions (message_id, username, emoji)
                VALUES (?, ?, ?)
            """, (message_id, username, emoji))
            active = True
    payload = {"message_id": message_id, "username": username, "emoji": emoji, "active": active}
    socketio.emit("reaction_update", payload, room=f"user:{row['sender']}")
    if row["recipient"] != row["sender"]:
        socketio.emit("reaction_update", payload, room=f"user:{row['recipient']}")


@socketio.on("typing")
def on_typing(data):
    username = sid_to_username.get(request.sid)
    recipient = (data or {}).get("recipient", "").strip()
    if username and recipient in online_users:
        socketio.emit("typing", {"username": username}, room=f"user:{recipient}")


@socketio.on("stop_typing")
def on_stop_typing(data):
    username = sid_to_username.get(request.sid)
    recipient = (data or {}).get("recipient", "").strip()
    if username and recipient in online_users:
        socketio.emit("stop_typing", {"username": username}, room=f"user:{recipient}")


@socketio.on("disconnect")
def on_disconnect():
    username = sid_to_username.pop(request.sid, None)
    if username and online_users.get(username) == request.sid:
        online_users.pop(username, None)
        emit_presence()


init_db()

if __name__ == "__main__":
    print("=" * 42)
    print("ChatLink upgraded server starting...")
    print("Open http://localhost:5000 on this laptop.")
    print("Friends on the same Wi-Fi use http://YOUR-LAN-IP:5000")
    print("=" * 42)
    socketio.run(app, host="0.0.0.0", port=5000, debug=False, allow_unsafe_werkzeug=True)
