const WS_URL = 'ws://localhost:8765';
let ws = null;
let sendQueue = [];
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let reconnectTimer = null;
let manualClose = false;

function sendOrQueueRaw(text) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(text);
    } catch (e) {
      console.error('[Bridge] send failed, queueing', e);
      sendQueue.push(text);
    }
  } else {
    sendQueue.push(text);
  }
}

function sendOrQueue(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  sendOrQueueRaw(text);
}

function flushQueue() {
  while (sendQueue.length && ws && ws.readyState === WebSocket.OPEN) {
    const msg = sendQueue.shift();
    try { ws.send(msg); } catch (e) { console.error('[Bridge] flush send failed', e); sendQueue.unshift(msg); break; }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  console.warn('[Bridge] scheduling reconnect in', delay, 'ms');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createWebSocket();
    reconnectDelay = Math.min(MAX_RECONNECT_DELAY, reconnectDelay * 2);
  }, delay);
}

function createWebSocket() {
  ws = new WebSocket(WS_URL);

  updateUiState('connecting');

  ws.onopen = () => {
    console.log('[Bridge] WebSocket connected');
    reconnectDelay = 1000; 
    flushQueue();
    updateUiState('connected');
  };

  ws.onmessage = event => {
    let msg = event.data;
    let payload = null;
    try {
      payload = JSON.parse(msg);
    } catch (e) {

      payload = { prompt: msg };
    }

    if (payload && payload.__control__) {
      if (payload.__control__ === 'open_new_copilot') {
        console.warn('[Bridge] received control=open_new_copilot');

        try {
          chrome.runtime.sendMessage({ action: 'openNewCopilot' }, resp => {  });
        } catch (e) { console.error('[Bridge] failed to send openNewCopilot', e); }
        return;
      }
    }

    chrome.runtime.sendMessage({ action: 'runCopilot', prompt: payload.prompt, attachments: payload.attachments }, response => {

      try {
        const replyText = (response && typeof response.reply !== 'undefined') ? response.reply : '';
        sendOrQueue(replyText);
      } catch (err) {
        console.error('[Bridge] failed to send reply over ws, queued instead', err);
        try { sendOrQueue(JSON.stringify({ reply: String(err) })); } catch (e2) {}
      }

      try {
        chrome.runtime.sendMessage({ action: 'openNewCopilot', force: true }, resp => {  });
      } catch (e) { console.error('[Bridge] failed to request reopen', e); }
    });
  };

  ws.onerror = err => console.error('[Bridge] WebSocket error', err);

  ws.onclose = ev => {
    console.warn('[Bridge] WebSocket closed', ev);
    updateUiState('disconnected');
    if (!manualClose) scheduleReconnect();
  };
}

createWebSocket();

function updateUiState(state) {
  try {
    const el = document.getElementById('wsState');
    if (el) el.textContent = state;
  } catch (e) {}
}

window.addEventListener('message', ev => {
  if (!ev.data || !ev.data.__bridge__) return;
  const cmd = ev.data.cmd;
  if (cmd === 'closeWs') {
    manualClose = true;
    try { ws && ws.close(); } catch (e) {}
    updateUiState('closed');
  } else if (cmd === 'reconnectWs') {
    manualClose = false;
    try { if (!ws || ws.readyState === WebSocket.CLOSED) createWebSocket(); } catch (e) {}
    updateUiState('reconnecting');
  }
});