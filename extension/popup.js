const chatContainer = document.getElementById('chatContainer');
const inputEl       = document.getElementById('promptInput');
const sendBtn       = document.getElementById('sendBtn');

sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') sendMessage();
});

function appendMessage(text, cls) {
  const msg = document.createElement('div');
  msg.className = 'message ' + cls;
  msg.textContent = text;
  chatContainer.appendChild(msg);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;
  appendMessage(text, 'user');
  inputEl.value = '';
  sendBtn.disabled = true;

  appendMessage('…waiting for Copilot…', 'ai');
  const placeholderNode = chatContainer.lastChild;

  chrome.runtime.sendMessage(
    { action: 'runCopilot', prompt: text },
    response => {
      sendBtn.disabled = false;
      if (chrome.runtime.lastError || response.reply.startsWith('Error')) {
        placeholderNode.textContent = 'Error: ' +
          (chrome.runtime.lastError?.message || response.reply);
      } else {
        placeholderNode.textContent = response.reply;
      }
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
  );
}
