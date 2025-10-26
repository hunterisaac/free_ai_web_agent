import asyncio
import os
import json
import re
import base64
from pathlib import Path
from datetime import datetime
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError

async def start_bridge_server(host='localhost', port=8765):
    try:
        import websockets
    except Exception as e:
        print(f"⚠️ websockets package not available; bridge server will not start: {e}")
        return None

    clients = set()

    async def safe_send(ws, message):
        try:
            await ws.send(message)
        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception as e:
            print(f"⚠️ Error sending to client: {e}")

    async def handler(websocket):
        clients.add(websocket)
        print(f"[WS Server] Client connected. total clients={len(clients)}")
        try:
            async for message in websocket:

                for ws in list(clients):
                    if ws != websocket:
                        await safe_send(ws, message)
        finally:
            clients.remove(websocket)
            print(f"[WS Server] Client disconnected. total clients={len(clients)}")

    server = await websockets.serve(handler, host, port, max_size=None)
    print(f"[WS Server] listening on ws://{host}:{port}")
    return server

BASE_DIR = Path(__file__).resolve().parent
COMMANDS_PATH = BASE_DIR / 'commands.txt'

task = input("What is your goal? ")

def parse_selector(raw: str) -> str:
    if "=" not in raw:
        raise ValueError("Selector must be in format type=value")
    sel_type, value = raw.split("=", 1)
    sel_type = sel_type.strip().lower()
    value = value.strip()

    if sel_type == "id":
        return f"#{value}"
    elif sel_type == "class":
        return "." + ".".join(value.split())
    elif sel_type == "name":
        return f"[name='{value}']"
    elif sel_type == "tag":
        return value
    elif sel_type == "text":
        return f"text={value}"
    elif sel_type == "attr":
        key, val = value.split("=", 1)
        return f"[{key}='{val}']"
    else:
        raise ValueError(f"Unsupported selector type: {sel_type}")

async def get_locator(page, raw_selector: str):
    selector = parse_selector(raw_selector)
    return page.locator(selector)

async def capture_artifacts(page):

    screenshot_path = "screenshot.png"
    try:
        await page.screenshot(path=screenshot_path, full_page=True)
        print(f"📸 Screenshot saved: {screenshot_path}")
    except Exception as e:
        print(f"⚠️ Screenshot failed: {e}")

    html_path = "page.html"
    txt_path = "page.txt"
    try:
        content = await page.content()
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(html_path, txt_path)
        print(f"📝 Page HTML saved as TXT: {txt_path}")
    except Exception as e:
        print(f"⚠️ Save page content failed: {e}")

async def open_url(page, url: str):
    try:
        await page.goto(url)
        print(f"✅ Opened URL: {url}")
    except PlaywrightTimeoutError as e:
        print(f"❌ Navigation timeout: {e}")
    except Exception as e:
        print(f"❌ open_url failed: {e}")
    finally:
        await capture_artifacts(page)

async def click_element(page, raw_selector: str):
    try:
        locator = await get_locator(page, raw_selector)
        await locator.first.click()
        print(f"✅ Clicked element: {raw_selector}")
    except Exception as e:
        print(f"❌ Click failed: {e}")
    finally:
        await capture_artifacts(page)

async def send_keys(page, raw_selector: str, text: str):
    try:
        locator = await get_locator(page, raw_selector)
        await locator.fill(text)
        print(f"✅ Sent keys to {raw_selector}: '{text}'")
    except Exception as e:
        print(f"❌ send_keys failed: {e}")
    finally:
        await capture_artifacts(page)

async def ask_copilot_and_get_reply(prompt_text: str):
    """Connect to local websocket server and send prompt + attachments, return reply text.

    Expects a websocket server at ws://localhost:8765 that accepts a JSON message with
    keys: 'prompt' (string) and 'attachments' (list of {name,type,data or dataURL}).
    """
    try:
        import websockets
    except Exception as e:
        print(f"❌ websockets package not available: {e}")
        return None

    base = Path(__file__).resolve().parent
    page_path = base / 'page.txt'
    screenshot_path = base / 'screenshot.png'
    commands_path = base / 'commands.txt'

    attachments = []
    if page_path.exists():
        text_data = page_path.read_text(encoding='utf-8')
        attachments.append({'name': 'page.txt', 'type': 'text/plain', 'data': text_data})
    else:
        print(f"Warning: {page_path} not found; skipping page.txt")

    if screenshot_path.exists():
        b = screenshot_path.read_bytes()
        b64 = base64.b64encode(b).decode('ascii')
        data_url = f'data:image/png;base64,{b64}'
        attachments.append({'name': 'screenshot.png', 'type': 'image/png', 'dataURL': data_url})
    else:
        print(f"Warning: {screenshot_path} not found; skipping screenshot.png")

    if commands_path.exists():
        try:
            cmds = commands_path.read_text(encoding='utf-8')
            attachments.append({'name': 'commands.txt', 'type': 'text/plain', 'data': cmds})
        except Exception as e:
            print(f"⚠️ Could not read commands.txt: {e}")
    else:
        print(f"Notice: {commands_path} not found; skipping commands.txt")

    message = {'prompt': prompt_text, 'attachments': attachments}

    try:

        async with websockets.connect("ws://localhost:8765", max_size=None) as ws:
            try:
                await ws.send(json.dumps(message))
            except websockets.exceptions.ConnectionClosedError as e:
                print(f"❌ ask_copilot send failed (connection closed): {e}")
                return None

            try:
                reply = await ws.recv()
                return reply
            except websockets.exceptions.ConnectionClosedError as e:
                print(f"❌ ask_copilot recv failed (connection closed): {e}")
                return None
    except Exception as e:
        print(f"❌ ask_copilot failed: {e}")
        return None

def format_instructions_for_copilot(task: str) -> str:
    """Return a detailed instruction string to send to Copilot describing available commands
    and required response format.
    """
    instructions = (
        f"Task: {task}\n\n"
        "You are an automation assistant that replies with the next action(s) to take. "
        "Determine if the task is complete; if so, respond with the 'exit' action.\n"
        "Please prevent infinite loops by checking the previously executed commands in commands.txt.\n"
        "Only use the allowed commands listed below. Respond ONLY with a raw JSON object (not a quoted JSON string) using one of these shapes:\n"
        "1) Single action: {\"action\": \"open_url\", \"args\": [\"http://example.com\"] }\n"
        "2) Multiple actions: {\"actions\": [{\"action\": \"click_element\", \"args\": [\"id=submitBtn\"]}, {\"action\": \"send_keys\", \"args\": [\"name=username\", \"myuser\"] }] }\n\n"
        "Allowed actions and arg formats:\n"
        "- open_url(url) => args: [url]\n"
        "- click_element(selector) => args: [selector] where selector is type=value (id=..., name=..., class=..., tag=..., text=..., attr=key=value)\n"
        "- send_keys(selector, text) => args: [selector, text]\n"
        "- exit => args: [] (closes the controller when task is FINISHED)\n"
        "- break_loop => args: [] (stop automated polling temporarily)\n"
        "- noop => args: [] (no operation; can be used to wait)\n\n"
        "When choosing element identifiers (id, name, class) consult the .txt file which contains the page HTML. "
        "Do not include any explanatory text outside the JSON object. If your system for some reason wraps the JSON object as a string, return the raw object instead (the controller can attempt a secondary parse but raw JSON is preferred).\n"
    )
    return instructions

def action_json_to_command(action: dict) -> str:
    """Convert action JSON (with 'action' and 'args') into our command string format."""
    name = action.get('action')
    args = action.get('args', []) or []
    if name == 'open_url' and len(args) >= 1:
        return f"open_url({args[0]})"
    elif name == 'click_element' and len(args) >= 1:
        return f"click_element({args[0]})"
    elif name == 'send_keys' and len(args) >= 2:

        return f"send_keys({args[0]}, text={args[1]})"
    elif name == 'exit':
        return 'exit'
    elif name == 'break_loop':

        return 'break_loop'
    elif name == 'noop':
        return ''
    else:
        return ''

async def handle_exit_request(browser, page) -> bool:
    """Ask the user if there's anything else to do when an exit is requested.

    Returns True to continue running (user provided another task), False to exit.
    If the user wants to continue, this will update the global `task` variable.
    If the user wants to exit, this will close the browser before returning False.
    """
    global task
    while True:
        ans = input("Exit requested. Is there anything else to be done? (y = yes, n = no): ").strip().lower()
        if ans in ('y', 'yes'):
            new_task = input("Enter the additional high-level task (leave blank to keep previous): ").strip()
            if new_task:
                task = new_task
            print("Resuming automation with updated task.")
            return True
        elif ans in ('n', 'no'):
            try:
                await browser.close()
            except Exception:
                pass
            return False
        else:
            print("Please enter 'y' or 'n'.")

def print_available_commands():
    print("\n📜 Available Commands:")
    print("  open_url(http://example.com)")
    print("  click_element(type=value)")
    print("  send_keys(type=value, text=yourtext)")
    print("  ask_copilot    -> Ask Copilot what to do next")
    print("  autoconfirm on|off -> when on, Copilot suggestions are executed automatically")
    print("  exit")
    print("🔍 Selector types: id, class, name, tag, text, attr")
    print("    Examples:")
    print("      click_element(id=submitBtn)")
    print("      send_keys(name=username, text=David123)")
    print("      click_element(attr=data-test=login-button)\n")

async def process_command(page, cmd: str):

    try:
        if cmd.startswith("open_url(") and cmd.endswith(")"):
            url = cmd[len("open_url("):-1]
            await open_url(page, url)

        elif cmd.startswith("click_element(") and cmd.endswith(")"):
            raw = cmd[len("click_element("):-1]
            await click_element(page, raw)

        elif cmd.startswith("send_keys(") and cmd.endswith(")"):
            inner = cmd[len("send_keys("):-1]

            if ',' in inner:
                sel_part, rest = inner.split(',', 1)
                sel = sel_part.strip()
                txt = rest.strip()

                if txt.startswith('text='):
                    txt = txt.split('=', 1)[1]
            else:

                parts = [x.strip() for x in inner.split(",")]
                sel = next((p for p in parts if "=" in p and not p.startswith("text=")), None)
                txt = next((p for p in parts if p.startswith("text=")), None)
                if txt:
                    txt = txt.split('=', 1)[1]

            if sel and txt is not None:
                await send_keys(page, sel, txt)
            else:
                print("❌ send_keys format: send_keys(type=value, text=yourtext)")

        elif cmd == "exit":
            return "exit"

        elif cmd == 'break_loop':

            return 'break_loop'

        else:
            print(f"❓ Unknown command: {cmd}")
    finally:

        try:
            await capture_artifacts(page)
        except Exception as e:
            print(f"⚠️ capture_artifacts failed: {e}")

def append_command_to_log(cmd: str):
    try:
        timestamp = datetime.utcnow().isoformat() + 'Z'
        with open(COMMANDS_PATH, 'a', encoding='utf-8') as f:
            f.write(f"[{timestamp}] {cmd}\n")
    except Exception as e:
        print(f"⚠️ Failed to append to commands log: {e}")

async def main():
    async with async_playwright() as p:

        bridge_server = None
        try:
            bridge_server = await start_bridge_server()
        except Exception as e:
            print(f"⚠️ Failed to start embedded bridge server: {e}")

        browser = await p.chromium.launch(headless=False)
        page = await browser.new_page()

        try:
            COMMANDS_PATH.write_text('', encoding='utf-8')
            print(f"🧾 Cleared commands log for this session: {COMMANDS_PATH}")
        except Exception as e:
            print(f"⚠️ Could not clear commands log at session start: {e}")

        try:
            await capture_artifacts(page)
        except Exception as e:
            print(f"⚠️ Initial capture failed: {e}")
        print("🎮 Barebones Web Controller with Copilot integration")
        print_available_commands()

        print("🤖 Starting automated Copilot loop. Type 'manual' to enter manual command mode, or 'exit' to quit.")
        automated = True

        while True:
            ans = input("Enable autoconfirm (auto-execute Copilot suggestions) at startup? (y/n): ").strip().lower()
            if ans in ('y', 'yes'):
                autoconfirm = True
                break
            elif ans in ('n', 'no'):
                autoconfirm = False
                break
            else:
                print("Please enter 'y' or 'n'.")
        while True:
            if automated:
                inst = format_instructions_for_copilot(task)
                print("\n🛰 Asking Copilot what to do next...")
                reply = await ask_copilot_and_get_reply(inst)
                if not reply:
                    print("❌ No reply from Copilot. Retrying in 3 seconds...")
                    await asyncio.sleep(3)
                    continue

                try:
                    data = json.loads(reply)
                except Exception as e:
                    print(f"❌ Could not parse Copilot reply as JSON: {e}\nRaw reply:\n{reply}")
                    await asyncio.sleep(2)
                    continue

                if isinstance(data, str):
                    try:
                        data2 = json.loads(data)
                        data = data2
                    except Exception:
                        print("❌ Copilot reply was a JSON string but secondary parse failed.\nRaw inner string:\n" + data)
                        await asyncio.sleep(2)
                        continue

                actions = []

                if not isinstance(data, dict):
                    print(f"❌ Copilot reply is not a JSON object as expected. Raw parsed value: {repr(data)}")
                    await asyncio.sleep(2)
                    continue

                if 'actions' in data and isinstance(data['actions'], list):
                    actions = data['actions']
                elif 'action' in data:
                    actions = [data]
                else:
                    print(f"❌ Unrecognized reply schema from Copilot: {data}")
                    await asyncio.sleep(2)
                    continue

                print("\n🔎 Copilot suggested the following action(s):")
                for i, act in enumerate(actions, start=1):
                    print(f"  {i}. {json.dumps(act)}")

                if any(a.get('action') == 'break_loop' for a in actions):
                    print("🛑 Copilot requested to break the automated loop. Stopping automated polling.")
                    automated = False

                    actions = [a for a in actions if a.get('action') != 'break_loop']
                    if not actions:
                        continue

                if autoconfirm:
                    print("⚡ Autoconfirm is ON — executing Copilot actions automatically.")
                    for act in actions:
                        cmdstr = action_json_to_command(act)
                        if not cmdstr:
                            print(f"⚠️ Skipping unsupported or empty action: {act}")
                            continue
                        print(f"▶ Executing Copilot action: {cmdstr}")

                        append_command_to_log(cmdstr)
                        res = await process_command(page, cmdstr)
                        if res == 'exit':
                                cont = await handle_exit_request(browser, page)
                                if not cont:
                                    return
                    await asyncio.sleep(1)
                    continue

                while True:
                    choice = input("Approve and execute these actions? (y = yes, n = no, m = manual, a = toggle autoconfirm, e = exit): ").strip().lower()
                    if choice == 'y':
                        for act in actions:
                            cmdstr = action_json_to_command(act)
                            if not cmdstr:
                                print(f"⚠️ Skipping unsupported or empty action: {act}")
                                continue
                            print(f"▶ Executing Copilot action: {cmdstr}")
                            append_command_to_log(cmdstr)
                            res = await process_command(page, cmdstr)
                            if res == 'exit':
                                    cont = await handle_exit_request(browser, page)
                                    if not cont:
                                        return

                        await asyncio.sleep(1)
                        break
                    elif choice == 'n':
                        print("⛔ Copilot suggestion rejected. Asking again in 1 second...")
                        await asyncio.sleep(1)
                        break
                    elif choice == 'm':
                        automated = False
                        print("✋ Switched to manual mode. Type commands or 'auto' to resume automated Copilot loop.")
                        break
                    elif choice == 'a':
                        autoconfirm = not autoconfirm
                        print(f"🔁 Autoconfirm set to {autoconfirm}")
                        if autoconfirm:
                            print("⚡ Autoconfirm enabled — will execute subsequent Copilot suggestions automatically.")
                        break
                    elif choice == 'e' or choice == 'exit':
                            cont = await handle_exit_request(browser, page)
                            if not cont:
                                return
                    else:
                        print("Please enter y, n, m, a, or e.")

            else:

                cmd = input("Manual command (or 'auto' to resume): ").strip()
                if cmd == 'auto':
                    automated = True
                    print("🔁 Resuming automated Copilot loop...")
                    continue

                if cmd.startswith('autoconfirm'):
                    parts = cmd.split()
                    if len(parts) >= 2 and parts[1].lower() in ('on', 'off'):
                        autoconfirm = parts[1].lower() == 'on'
                        print(f"🔁 Autoconfirm set to {autoconfirm}")
                        continue

                append_command_to_log(cmd)
                if await process_command(page, cmd) == "exit":
                    break

        try:
            await browser.close()
        except Exception:
            pass

        if bridge_server:
            try:
                bridge_server.close()
                await bridge_server.wait_closed()
                print("[WS Server] stopped")
            except Exception as e:
                print(f"⚠️ Error shutting down WS server: {e}")

if __name__ == "__main__":
    asyncio.run(main())