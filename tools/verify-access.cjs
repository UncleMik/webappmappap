const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runtime = path.join(__dirname, 'preview-runtime');
const config = JSON.parse(fs.readFileSync(path.join(runtime, 'access.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(runtime, 'status.json'), 'utf8'));
const auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
async function check(base) {
  const request = (file, authorization) => fetch(base + file, {headers: authorization ? {Authorization: authorization} : {}, redirect: 'manual', signal: AbortSignal.timeout(15000)});
  for (const file of ['/', '/app.js', '/assets/reference.png']) {
    const response = await request(file);
    assert.equal(response.status, 401, `Unauthenticated: ${file}`);
    assert.match(response.headers.get('www-authenticate'), /^Basic/);
    await response.body.cancel();
  }
  const wrong = await request('/', 'Basic d3Jvbmc6d3Jvbmc=');
  assert.equal(wrong.status, 401); await wrong.body.cancel();
  const invalid = await request('/%00', auth);
  assert.equal(invalid.status, 400); await invalid.body.cancel();
  for (const file of ['/', '/baby.html', '/mom.html', '/journey.html', '/ai.html', '/club.html', '/profile.html', '/app.js', '/styles.css']) {
    const response = await request(file, auth);
    assert.equal(response.status, 200, `Authenticated: ${file}`);
    assert.equal(await response.text(), fs.readFileSync(path.join(__dirname, '../Фронт', file === '/' ? 'index.html' : file.slice(1)), 'utf8'));
  }
  for (const file of ['/server.cjs', '/package.json', '/AGENTS.md', '/%2e%2e%5ctools%5cpreview-runtime%5caccess.json', '/.env']) {
    const response = await request(file, auth);
    assert.ok([403, 404].includes(response.status), `Private file blocked: ${file}`);
    await response.body.cancel();
  }
  console.log(`PASS: authentication, pages and private files: ${base}`);
}
(async () => { await check(`http://127.0.0.1:${config.port}`); assert.ok(state.url); await check(state.url); })().catch(error => { console.error(error.message); process.exitCode = 1; });
