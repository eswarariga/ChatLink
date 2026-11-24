# ChatLink Upgraded

## Folder structure
ChatLink/
  app.py
  requirements.txt
  chatlink.db        (created automatically after first run)
  templates/
    index.html
  static/
    style.css
    script.js
  uploads/           (uploaded files are stored here)

## Setup (Windows)
1. Open this folder in VS Code.
2. Open Terminal > New Terminal.
3. Run:
   py -m pip install -r requirements.txt
4. Start:
   py app.py
5. Open http://localhost:5000

## Let a friend connect
1. Both laptops must be on the same Wi-Fi.
2. On the server laptop, open Command Prompt and run `ipconfig`.
3. Find the Wi-Fi adapter's IPv4 Address.
4. Your friend opens `http://YOUR-IP:5000` (replace YOUR-IP).
5. If Windows Firewall asks, allow Python on Private networks.

## Notes
- SQLite chat history is saved in chatlink.db.
- Uploaded files are stored in uploads/.
- File sharing limit: 10 MB. Allowed types: common images, PDF, Office documents, TXT, CSV, ZIP.
- This is a student LAN demo, not a secure public messaging service. Usernames are not authenticated and traffic is not end-to-end encrypted. Use only on a trusted network.
- Keep the server laptop and terminal running while friends use the chat.
- Socket.IO client is loaded from a CDN, so browser clients need internet access to load that library.
