document.addEventListener('DOMContentLoaded', () => {
  const wsStateEl = document.getElementById('wsState');
  const closeBtn = document.getElementById('closeWs');
  const reconnectBtn = document.getElementById('reconnectWs');
  const copyBtn = document.getElementById('copyUrl');
  const logEl = document.getElementById('log');

  const toast = document.createElement('div');
  toast.id = 'toast';
  document.body.appendChild(toast);

  function log(msg, level = 'info') {
    const row = document.createElement('div');
    row.className = 'logRow ' + level;
    const time = new Date().toLocaleTimeString();
    const icon = level === 'error' ? '❗' : level === 'action' ? '➡️' : level === 'state' ? '🔁' : '•';
    row.textContent = `${icon} [${time}] ${msg}`;
    logEl.appendChild(row);

    if (logEl.children.length > 200) logEl.removeChild(logEl.children[0]);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function showToast(text, timeout = 2000) {
    toast.textContent = text;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), timeout);
  }

  const stateObserver = new MutationObserver(() => {
    const s = wsStateEl.textContent.trim();
    log('WebSocket state: ' + s, 'state');
    setBadgeClass(s);
  });
  stateObserver.observe(wsStateEl, { childList: true, subtree: true, characterData: true });

  function setBadgeClass(state) {
    const badge = wsStateEl.parentElement;
    badge.classList.remove('connecting','connected','disconnected','closed');
    if (/connect/i.test(state)) badge.classList.add('connecting');
    else if (/connected/i.test(state)) badge.classList.add('connected');
    else if (/closed/i.test(state)) badge.classList.add('closed');
    else badge.classList.add('disconnected');
  }

  closeBtn.addEventListener('click', () => {
    window.postMessage({ __bridge__: true, cmd: 'closeWs' }, '*');
    log('Requested close of WebSocket', 'action');
    showToast('Requested close of WebSocket');
  });

  reconnectBtn.addEventListener('click', () => {
    window.postMessage({ __bridge__: true, cmd: 'reconnectWs' }, '*');
    log('Requested WebSocket reconnect', 'action');
    showToast('Requested WebSocket reconnect');
  });

  copyBtn.addEventListener('click', async () => {

    const defaultUrl = 'ws://localhost:8765';
    try {
      await navigator.clipboard.writeText(defaultUrl);
      log('Copied WS URL to clipboard: ' + defaultUrl, 'action');
      showToast('WS URL copied');
    } catch (e) {
      log('Failed to copy to clipboard', 'error');
      showToast('Failed to copy');
    }
  });

  window.addEventListener('message', ev => {
    if (!ev.data || typeof ev.data !== 'object') return;
    const d = ev.data;
    if (d.__bridge_event__) {
      log('Bridge: ' + (d.message || JSON.stringify(d)), 'bridge');
      if (d.state) {
        wsStateEl.textContent = d.state;
      }
    }
  });

  log('Shell ready');
});