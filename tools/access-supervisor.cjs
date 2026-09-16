const fs = require('node:fs');
const path = require('node:path');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const runtime = path.join(__dirname, 'preview-runtime');
const config = JSON.parse(fs.readFileSync(path.join(runtime, 'access.json'), 'utf8'));
const auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
const local = `http://127.0.0.1:${config.port}`;
const stateFile = path.join(runtime, 'status.json');
const attemptsFile = path.join(runtime, 'delivery.json');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const save = (file, value) => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2)); fs.renameSync(`${file}.tmp`, file); };
const log = (event) => {
  const file = path.join(runtime, 'supervisor.log');
  if (fs.existsSync(file) && fs.statSync(file).size > 2e6) fs.renameSync(file, `${file}.previous`);
  fs.appendFileSync(file, `${new Date().toISOString()} ${event}\n`);
};
const state = {pid: process.pid, startedAt: new Date().toISOString(), status: 'starting', url: null};
const attempts = readJson(attemptsFile);
let tunnel, url, started = 0, failures = 0, busy = false, stopping = false, nextStart = 0, nextProbe = 0;
const persist = () => save(stateFile, {...state, tunnelPid: tunnel?.pid, checkedAt: new Date().toISOString()});

async function probe(base) {
  try {
    const response = await fetch(`${base}/`, {headers: {Authorization: auth}, redirect: 'manual', signal: AbortSignal.timeout(12000)});
    return response.status === 200 && await response.text() === fs.readFileSync(path.join(__dirname, '../Фронт/index.html'), 'utf8');
  } catch { return false; }
}

async function notify() {
  const previous = attempts[url];
  if (previous && previous.status !== 'retry') {
    state.telegram = previous;
    return;
  }
  // Persist before dispatch: a crash or lost reply must not cause a blind duplicate.
  const attempt = {status: 'sending', attemptedAt: new Date().toISOString()};
  attempts[url] = attempt;
  save(attemptsFile, attempts);
  const text = `ВебПрил — сайт доступен\n\nСсылка: ${url}\nЛогин: ${config.username}\nПароль: ${config.password}\n\nЕсли адрес изменится, пришлю новую ссылку вместе с данными для входа.\nСайт работает, пока ПК включён, не спит и подключён к интернету.`;
  try {
    const {stdout} = await run(process.execPath, [config.telegramSender, 'send-message', text], {
      cwd: config.telegramRoot, windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    if (result.ok !== true || result.chatIdMatchesAllowlist !== true) throw new Error('Unconfirmed delivery');
    Object.assign(attempt, {status: 'delivered', messageId: result.messageId, deliveredAt: new Date().toISOString()});
    log(`Telegram delivery confirmed: message ${result.messageId}`);
  } catch (error) {
    // Only DNS / connection failures positively known to precede sending may retry.
    const detail = String(error.stderr || '');
    attempt.status = /curl: \((6|7)\)/.test(detail) ? 'retry' : 'uncertain';
    log(`Telegram delivery ${attempt.status}; inspect status.json before manual resend`);
  }
  save(attemptsFile, attempts);
  state.telegram = attempt;
  persist();
}

function startTunnel() {
  url = null; state.url = null; state.status = 'connecting'; delete state.telegram;
  failures = 0; started = Date.now(); nextProbe = 0;
  const child = spawn(config.cloudflared, ['tunnel', '--url', local, '--no-autoupdate', '--protocol', 'http2'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: runtime,
  });
  tunnel = child;
  let tail = '';
  const consume = (data) => {
    tail = (tail + data.toString()).slice(-16000);
    const match = tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !url && tunnel === child) {
      url = match[0]; state.url = url; persist(); log(`New tunnel: ${url}`);
    }
  };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  child.on('error', () => log('Tunnel could not start'));
  child.on('close', () => {
    if (tunnel !== child) return;
    tunnel = null; url = null; state.url = null; state.status = 'reconnecting';
    nextStart = Date.now() + 15000; persist(); log('Tunnel exited; restart scheduled');
  });
  persist();
}

async function tick() {
  if (busy || stopping) return;
  busy = true;
  try {
    if (!tunnel) { if (Date.now() >= nextStart) startTunnel(); return; }
    if (!url) { if (Date.now() - started > 120000) tunnel.kill(); return; }
    if (Date.now() < nextProbe) return;
    nextProbe = Date.now() + 30000;
    if (await probe(url)) {
      failures = 0; state.status = 'online'; state.lastHealthyAt = new Date().toISOString();
      persist(); await notify();
    } else {
      failures++; state.status = 'checking'; persist();
      if (failures >= 6 && await probe(local)) { log('Public health check failed six times; replacing tunnel'); tunnel.kill(); }
    }
  } catch { log('Supervisor cycle failed; next cycle will retry'); }
  finally { busy = false; }
}

async function main() {
  process.env.PORT = String(config.port);
  const server = require('../Фронт/server.cjs');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  // Only clean up this site's recorded orphan, after acquiring its exclusive port.
  const old = readJson(stateFile);
  if (Number.isInteger(old.tunnelPid)) {
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${old.tunnelPid}'; if ($p.Name -eq 'cloudflared.exe' -and $p.CommandLine -like '*--url ${local} *') { Stop-Process -Id $p.ProcessId -Force }`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true}).catch(() => {});
  }
  persist(); log('Supervisor started');
  const timer = setInterval(tick, 5000); await tick();
  const stop = () => { stopping = true; clearInterval(timer); tunnel?.kill(); server.close(); state.status = 'stopped'; persist(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
main().catch(() => { log('Startup failed (configuration or port conflict)'); process.exit(1); });
