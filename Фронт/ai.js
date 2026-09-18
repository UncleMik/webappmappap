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
  document.querySelector('#conversation').append(message);
  input.value = '';
  showStatus('Это демонстрация чата. AI пока не подключён: сообщение не отправлено и исчезнет после перезагрузки.');
  message.scrollIntoView({ block: 'center' });
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
