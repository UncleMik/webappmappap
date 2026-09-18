const conversation = document.querySelector('#conversation');
const scrollToLatest = () => { conversation.scrollTop = conversation.scrollHeight; };
// Keep the composer above the mobile keyboard as the visible viewport changes.
const resizeChat = () => {
  document.documentElement.style.setProperty('--chat-viewport-height', `${window.visualViewport?.height ?? window.innerHeight}px`);
};
window.visualViewport?.addEventListener('resize', resizeChat);
window.addEventListener('resize', resizeChat);
resizeChat();
requestAnimationFrame(scrollToLatest);
document.fonts.ready.then(scrollToLatest);

const input = document.querySelector('#chat-input');
const status = document.querySelector('#chat-status');
const showStatus = text => { status.textContent = text; status.hidden = false; };

document.querySelectorAll('[data-prompt]').forEach(button => {
  button.addEventListener('click', () => {
    input.value = button.dataset.prompt;
    input.focus();
  });
});

document.querySelector('#chat-form').addEventListener('submit', event => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  const message = document.createElement('article');
  message.className = 'message user-message';
  const content = document.createElement('div');
  content.className = 'message-content';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  content.append(bubble);
  message.append(content);
  conversation.append(message);
  input.value = '';
  showStatus('Это демонстрация чата. AI пока не подключён: сообщение не отправлено и исчезнет после перезагрузки.');
  scrollToLatest();
});

document.querySelector('#attachment').addEventListener('click', () => {
  showStatus('Прикрепление файлов появится после подключения чата.');
});

const historyDialog = document.querySelector('#history-dialog');
document.querySelector('#history-open').addEventListener('click', () => historyDialog.showModal());
document.querySelector('#history-close').addEventListener('click', () => historyDialog.close());
document.querySelector('#return-chat').addEventListener('click', () => historyDialog.close());
historyDialog.addEventListener('click', event => {
  if (event.target !== historyDialog) return;
  const bounds = historyDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) historyDialog.close();
});
