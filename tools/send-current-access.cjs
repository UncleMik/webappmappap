// Run only when the user explicitly requests another Telegram delivery.
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const runtime = path.join(__dirname, 'preview-runtime');
async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(runtime, 'access.json'), 'utf8'));
  const state = JSON.parse(fs.readFileSync(path.join(runtime, 'status.json'), 'utf8'));
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(state.url || '')) throw new Error('No current tunnel');
  const response = await fetch(state.url, {
    headers: {Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`},
    redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 200 || await response.text() !== fs.readFileSync(path.join(__dirname, '../Фронт/index.html'), 'utf8')) throw new Error('Current link did not pass verification');
  const text = `ВебПрил — актуальная ссылка, проверено\n\n${state.url}\n\nЛогин: ${config.username}\nПароль: ${config.password}\n\nПредыдущие ссылки после перезапуска больше не работают. Если Telegram не показывает окно входа, открой ссылку через меню «Открыть в браузере» — в Chrome или Safari.\n\nАвтозапуск включён после входа в Windows. ПК должен быть включён и подключён к интернету.`;
  const {stdout} = await promisify(execFile)(process.execPath, [config.telegramSender, 'send-message', text], {
    cwd: config.telegramRoot, windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  if (result.ok !== true || result.chatIdMatchesAllowlist !== true) throw new Error('Delivery was not confirmed');
  const record = {url: state.url, messageId: result.messageId, deliveredAt: new Date().toISOString(), ok: true, chatIdMatchesAllowlist: true};
  fs.writeFileSync(path.join(runtime, 'manual-delivery.json'), JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
}
main().catch(() => { console.error('Verification or delivery failed. Inspect the Telegram chat before any repeat.'); process.exitCode = 1; });
