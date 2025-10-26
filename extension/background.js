function bglog(...args) {
  console.log('[BG]', ...args);
}

chrome.action.onClicked.addListener(() => {
  bglog('Toolbar icon clicked; opening chat UI');
  chrome.tabs.create({
    url: chrome.runtime.getURL('copilot-shell.html')
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  bglog('onMessage received:', msg);
  if (msg.action !== 'runCopilot') return;

  const attachments = msg.attachments || (msg.attachment ? [msg.attachment] : []);

  runCopilotFlow(msg.prompt, attachments)
    .then(reply => {
      bglog('runCopilotFlow resolved:', reply);
      sendResponse({ reply });
    })
    .catch(err => {
      bglog('runCopilotFlow failed:', err);
      sendResponse({ reply: 'Error: ' + err });
    });

  return true; 
});

let _lastOpenRequestTs = 0;
let _openInProgress = false;
const OPEN_COOLDOWN_MS = 5000; 

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openNewCopilot') {
    const now = Date.now();
    const force = !!msg.force;
    if (!force) {
      if (_openInProgress) {
        bglog('openNewCopilot suppressed because open already in progress');
        sendResponse({ ok: false, reason: 'in-progress' });
        return true;
      }
      if (now - _lastOpenRequestTs < OPEN_COOLDOWN_MS) {
        bglog('openNewCopilot suppressed by cooldown');
        sendResponse({ ok: false, reason: 'cooldown' });
        return true;
      }
    }
    _lastOpenRequestTs = now;
    _openInProgress = true;

    const clearOpenFlagTimer = setTimeout(() => { _openInProgress = false; bglog('openNewCopilot: clearing in-progress flag by timeout'); }, OPEN_COOLDOWN_MS * 2);

    bglog('openNewCopilot requested — closing existing copilot tabs and opening/focusing fresh one');

    if (force) {

      chrome.tabs.query({ url: 'https://copilot.microsoft.com/*' }, tabs => {
        if (tabs && tabs.length) {
          const ids = tabs.map(t => t.id).filter(Boolean);
          bglog('force: closing Copilot website tabs', ids);
          chrome.tabs.remove(ids, () => {
            bglog('force: closed Copilot website tabs, opening fresh Copilot site tab');
            chrome.tabs.create({ url: 'https://copilot.microsoft.com/' }, newTab => {
              clearTimeout(clearOpenFlagTimer);
              _openInProgress = false;
              sendResponse({ ok: true, opened: true, tabId: newTab.id, forced: true });
            });
          });
        } else {
          bglog('force: no existing Copilot site tabs, opening Copilot site');
          chrome.tabs.create({ url: 'https://copilot.microsoft.com/' }, newTab => {
            clearTimeout(clearOpenFlagTimer);
            _openInProgress = false;
            sendResponse({ ok: true, opened: true, tabId: newTab.id, forced: true });
          });
        }
      });
    } else {
      chrome.tabs.query({ url: chrome.runtime.getURL('copilot-shell.html') }, extTabs => {
        if (extTabs && extTabs.length) {
          const t = extTabs[0];
          bglog('found existing extension shell tab, focusing', t.id);
          chrome.tabs.update(t.id, { active: true }, () => {
            clearTimeout(clearOpenFlagTimer);
            _openInProgress = false;
            sendResponse({ ok: true, focused: true });
          });
          return;
        }

        chrome.tabs.query({ url: 'https://copilot.microsoft.com/*' }, tabs => {
          if (tabs && tabs.length) {
            const ids = tabs.map(t => t.id).filter(Boolean);
            bglog('closing copilot.microsoft.com tabs', ids);
            chrome.tabs.remove(ids, () => {
              bglog('closed old tabs, opening new extension tab');
              chrome.tabs.create({ url: chrome.runtime.getURL('copilot-shell.html') }, newTab => {
                clearTimeout(clearOpenFlagTimer);
                _openInProgress = false;
                sendResponse({ ok: true, opened: true, tabId: newTab.id });
              });
            });
          } else {
            bglog('no existing copilot site tabs, opening extension page');
            chrome.tabs.create({ url: chrome.runtime.getURL('copilot-shell.html') }, newTab => {
              clearTimeout(clearOpenFlagTimer);
              _openInProgress = false;
              sendResponse({ ok: true, opened: true, tabId: newTab.id });
            });
          }
        });
      });
    }

    return true; 
  }
});

async function runCopilotFlow(prompt, attachments) {
  bglog('→ start runCopilotFlow for prompt:', prompt);

  const tab = await findOrCreateTab();
  bglog('→ using tab:', tab.id, tab.url);

  await waitForLoad(tab.id);
  bglog('→ page loaded');

  await retryEnsureTextarea(tab.id, 3, 1000);
  bglog('→ textarea ready');

  if (attachments && attachments.length) {
    for (const att of attachments) {
      if (!att) continue;
      bglog('→ attaching file to Copilot composer:', att.name);
      try {

        if (att.dataURL) {
          await injectFileIntoPage(tab.id, att);
        } else if (att.data && att.type && att.name) {

          const dataURL = `data:${att.type};charset=utf-8,` + encodeURIComponent(att.data);
          await injectFileIntoPage(tab.id, { name: att.name, type: att.type, dataURL });
        } else {
          bglog('→ attachment missing expected fields, skipping', att);
          continue;
        }
        bglog('→ attachment injected');
      } catch (err) {
        bglog('→ attachment injection failed:', err);

      }

      await new Promise(r => setTimeout(r, 500));
    }
  }

  await sendPrompt(tab.id, prompt);
  bglog('→ prompt injected');

  const reply = await waitForResponse(tab.id, 30000, 700);
  bglog('→ response received');
  return reply;
}

function findOrCreateTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ url: 'https://copilot.microsoft.com/*' }, tabs => {
      if (tabs.length) {
        bglog('findOrCreateTab: found existing tab', tabs[0].id);
        return resolve(tabs[0]);
      }
      bglog('findOrCreateTab: creating new tab');
      chrome.tabs.create(
        { url: 'https://copilot.microsoft.com/', active: false },
        newTab => {
          bglog('findOrCreateTab: new tab opened', newTab.id);
          resolve(newTab);
        }
      );
    });
  });
}

function waitForLoad(tabId) {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, tab => {
      if (tab.status === 'complete') {
        bglog('waitForLoad: already complete');
        return resolve();
      }
      bglog('waitForLoad: waiting for load on tab', tabId);
      const listener = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          bglog('waitForLoad: load event fired');
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function retryEnsureTextarea(tabId, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      bglog(`retryEnsureTextarea: attempt ${i + 1}`);
      await ensureTextareaReady(tabId);
      return;
    } catch (err) {
      bglog(`retryEnsureTextarea: attempt ${i + 1} failed:`, err);
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function ensureTextareaReady(tabId) {
  bglog('ensureTextareaReady: injecting script');
  return chrome.scripting.executeScript({
    target: { tabId },
    func: (selector, timeout) => {
      return new Promise((res, rej) => {
        if (document.querySelector(selector)) return res();
        const obs = new MutationObserver(() => {
          if (document.querySelector(selector)) {
            obs.disconnect();
            res();
          }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
          obs.disconnect();
          rej(`Timeout waiting for ${selector}`);
        }, timeout);
      });
    },
    args: ['textarea[placeholder="Message Copilot"]', 5000]
  }).then(() => {
    bglog('ensureTextareaReady: textarea found');
  });
}

async function sendPrompt(tabId, prompt) {
  bglog('sendPrompt: injecting user text');

  await chrome.scripting.executeScript({
    target: { tabId },
    func: text => {

      const ta = document.querySelector('textarea[placeholder="Message Copilot"]') || document.querySelector('[role="textbox"]') || document.querySelector('div[contenteditable="true"]');
      if (!ta) throw 'Composer element not found';

      ta.focus();
      try {
        if (ta.tagName.toLowerCase() === 'textarea' || ta.tagName.toLowerCase() === 'input') {
          ta.value = '';
          ta.value = text;
          ta.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        } else {

          ta.innerText = '';
          ta.innerText = text;
          ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
      } catch (e) {

      }

      const fireKey = (type) => {
        const ev = new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true });
        ta.dispatchEvent(ev);
      };

      fireKey('keydown');
      fireKey('keypress');
      fireKey('keyup');

      const btnCandidates = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(n => n.offsetParent !== null); 

      let clicked = false;
      for (const n of btnCandidates) {
        try {
          const txt = (n.innerText || n.getAttribute('aria-label') || n.title || '').trim();
          if (!txt) continue;

          if (/share/i.test(txt)) continue;

          if (/^send$/i.test(txt) || /\bsend\b/i.test(txt)) {
            n.click();
            clicked = true;
            break;
          }
        } catch (e) {}
      }

      if (!clicked) {
        try {
          const composer = ta.closest('.group') || ta.closest('.composer') || document.body;
          const localBtns = Array.from(composer.querySelectorAll('button, [role="button"]'))
            .filter(n => n.offsetParent !== null);
          for (const n of localBtns) {
            const txt = (n.innerText || n.getAttribute('aria-label') || n.title || '').trim();
            if (!txt) continue;
            if (/share/i.test(txt)) continue;
            if (/^send$/i.test(txt) || /\bsend\b/i.test(txt)) {
              n.click();
              clicked = true;
              break;
            }
          }
        } catch (e) {}
      }
    },
    args: [prompt]
  });
}

async function injectFileIntoPage(tabId, attachment) {

  return chrome.scripting.executeScript({
    target: { tabId },
    func: (att, timeout) => {
      return new Promise((resolve, reject) => {
        try {

          const parts = att.dataURL.split(',');
          const meta = parts[0];
          const isBase64 = meta.indexOf('base64') !== -1;
          const matches = /data:([^;]+)(;base64)?/.exec(meta);
          const mime = matches ? matches[1] : att.type || 'application/octet-stream';
          const raw = parts[1];
          let binStr;
          if (isBase64) {
            binStr = atob(raw);
          } else {
            binStr = decodeURIComponent(raw);
          }
          const len = binStr.length;
          const u8 = new Uint8Array(len);
          for (let i = 0; i < len; i++) u8[i] = binStr.charCodeAt(i);
          const blob = new Blob([u8], { type: mime });
          const file = new File([blob], att.name, { type: mime });

          const inputFile = document.querySelector('input[type=file]');
          if (inputFile) {
            try {

              const dt = new DataTransfer();
              dt.items.add(file);
              inputFile.files = dt.files;

              inputFile.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e) {

              console.warn('input[type=file] assign failed, falling back to drag/drop', e);
              const dt2 = new DataTransfer();
              dt2.items.add(file);

              const selectors = [
                'textarea[placeholder="Message Copilot"]',
                '[role="textbox"]',
                '.composer'
              ];
              let target = null;
              for (const s of selectors) {
                const el = document.querySelector(s);
                if (el) { target = el; break; }
              }
              if (!target) target = document.body;
              const rect = target.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              const dragOver = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt2, clientX: x, clientY: y });
              const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt2, clientX: x, clientY: y });
              target.dispatchEvent(dragOver);
              setTimeout(() => target.dispatchEvent(drop), 50);
            }
          } else {

            const dt = new DataTransfer();
            dt.items.add(file);
            const selectors = [
              'textarea[placeholder="Message Copilot"]',
              '[role="textbox"]',
              '.composer'
            ];
            let target = null;
            for (const s of selectors) {
              const el = document.querySelector(s);
              if (el) { target = el; break; }
            }
            if (!target) target = document.body;
            const rect = target.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const dragOver = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y });
            const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y });
            target.dispatchEvent(dragOver);
            setTimeout(() => target.dispatchEvent(drop), 50);
          }

          const start = Date.now();
          const check = () => {

            const maybe = document.querySelector('img') || document.querySelector('[aria-label*="attachment"]') || document.querySelector('.attachment-preview') || document.querySelector('.file-name');
            if (maybe) return resolve(true);
            if (Date.now() - start > timeout) return reject('Timeout waiting for attachment preview');
            setTimeout(check, 200);
          };
          check();
        } catch (err) {
          reject(err?.toString?.() || String(err));
        }
      });
    },
    args: [attachment, 5000]
  }).then(results => {

    return true;
  });
}

async function waitForResponse(tabId, timeout = 30000, settleTime = 700) {
  bglog('waitForResponse: injecting observer script');
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (timeout, settleTime) => {
      return new Promise((resolve, reject) => {

        const selector = '.group\\/ai-message-item p';
        const initialCount = document.querySelectorAll(selector).length;
        let timeoutId, settleId;

        const cleanup = () => {
          obs.disconnect();
          clearTimeout(timeoutId);
          clearTimeout(settleId);
        };

        timeoutId = setTimeout(() => {
          cleanup();
          reject(`Timed out after ${timeout}ms waiting for AI response`);
        }, timeout);

        const assembleText = () => {
          return Array.from(document.querySelectorAll(selector))
            .slice(initialCount)
            .map(p => p.innerText.trim())
            .join('\n\n');
        };

        let lastText = assembleText();

        const report = () => {
          const text = assembleText();
          cleanup();
          resolve(text);
        };

        const scheduleIfChanged = () => {
          const text = assembleText();
          if (text !== lastText) {
            lastText = text;
            clearTimeout(settleId);
            settleId = setTimeout(report, settleTime);
          }
        };

        const obs = new MutationObserver(() => {
          scheduleIfChanged();
        });

        obs.observe(document.body, { childList: true, subtree: true, characterData: true });

        scheduleIfChanged();
      });
    },
    args: [timeout, settleTime]
  });

  bglog('waitForResponse: script resolved, returning reply');
  return injection.result;
}