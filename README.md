Copilot Automator — Local Setup (NOTE: this is a vibe-coded project used to experiment with the use of AI for programming)

This repository contains a Chrome extension UI and a local controller that together let you automate Copilot flows using a local WebSocket bridge.

Quick overview
- Extension UI: placed in `extension/` — load it as an unpacked extension in Chrome and click the toolbar button to open the full-page UI.
- Local controller: `controller.py` — launches Playwright, captures page artifacts and asks the local WebSocket bridge for instructions.

Prerequisites
- Python 3.9+ (or compatible)
- Node/Chrome not required for running the controller, but you must have Chrome installed to use the extension UI.
- Python packages: install Playwright and websockets. Example:

PowerShell
```powershell
python -m pip install -r requirements.txt
# or install minimal packages
python -m pip install playwright websockets
python -m playwright install chromium
```

Loading the extension into Chrome (unpacked)
1. Open Chrome and navigate to chrome://extensions/
2. Enable "Developer mode" (toggle in the top-right).
3. Click "Load unpacked" and select the `copilot chat/` folder from this repository.
4. The extension icon will appear in the toolbar. Click it to open the extension's full-page UI.

Using the UI and controller
1. Start the controller (this will also start the embedded WebSocket bridge by default):

PowerShell
```powershell
python controller.py
```

2. Click the extension icon in Chrome's toolbar to open the UI page. The UI shows WebSocket status, a small event log, and controls to close/reconnect the bridge.
3. The controller will interact with Copilot via Playwright and send/receive prompts over ws://localhost:8765.

Alternative: run the bridge separately
If you prefer running the bridge as a separate process (same behavior):

PowerShell
```powershell
python websocket\bridge_ws_server.py
```

Then run `python controller.py` (controller will not attempt to start the embedded bridge if the websockets package is missing; otherwise it will start one alongside the controller).

Notes
- The controller captures page HTML and a full-page screenshot and sends them as attachments when asking Copilot for the next actions.
- The UI and extension are intentionally minimal — the extension forwards prompts and replies to/from the local WebSocket bridge.
- If you want the UI to show more details (or copy commands), open `copilot chat/copilot-shell.html` and `copilot chat/shell.js` for the client-side code.

Security
- This project communicates over localhost only. Be mindful when running untrusted code that can send instructions into your browser.

Troubleshooting
- If the UI shows "disconnected", make sure the bridge is running and listening on ws://localhost:8765.
- If Playwright navigation fails, try running `python -m playwright install` and ensure Chrome/Chromium is available.

Contact
- This is a local automation tool. If you need enhancements (copy buttons, dynamic WS URL, or better logging), edit the files in `copilot chat/` and I can help implement improvements.
