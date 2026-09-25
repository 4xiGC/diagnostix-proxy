// ════════════════════════════════════════════════════════════════════════════
// A CHROME TEST NEVER DRIVES ANOTHER PROCESS'S CHROME (2026-09-30, Q14; after
// diagnostix-evp 24ea3c7).
//
// Every RVP Chrome test launched Chrome on a FIXED debugging port (9372, 9374,
// 9376, 9381, 9391, 9395, 9396, 9397) and took the first page listed there.
// Several of those are used by EVP and SVP tests too. When two suites run at
// once, the second Chrome cannot bind the port and the test attaches to the
// FIRST process's page and drives it, so both wait on a page that is not theirs.
// Now test-support/chrome-launch.mjs starts Chrome on port 0 and reads the port
// it bound from DevToolsActivePort in its own fresh profile directory.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { launchChrome } from '../test-support/chrome-launch.mjs';

const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const chromePath = CHROME.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

async function evaluate(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('the page socket did not open'))); });
  const out = await new Promise((res) => { ws.addEventListener('message', (m) => res(JSON.parse(m.data)));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });
  ws.close();
  return out.result && out.result.result ? out.result.result.value : undefined;
}

test('A PORT ALREADY HELD BY ANOTHER PROCESS IS NOT ATTACHED TO (9395, the wait-line test\'s old port)', { timeout: 30000 }, async () => {
  assert.ok(chromePath, 'NO CHROME FOUND, AND THAT IS A FAILURE, NOT A SKIP.');
  // A foreign "Chrome" on an old fixed port: it lists a page whose socket goes nowhere.
  const foreign = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ type: 'page', id: 'foreign', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/foreign' }]));
  });
  await new Promise((r) => foreign.listen(9395, '127.0.0.1', r));
  let chrome;
  try {
    chrome = await launchChrome(chromePath, 9395);
    assert.ok(chrome.target, 'no page');
    assert.notEqual(chrome.target.id, 'foreign', 'the launch attached to the foreign process on 9395');
    assert.notEqual(chrome.port, 9395, 'Chrome is on the port another process holds');
    assert.equal(await evaluate(chrome.target, '6 * 7'), 42, 'the page answered is not ours');
  } finally { if (chrome) chrome.kill(); foreign.close(); }
});

test('two launches at once get two different ports and two working pages', { timeout: 30000 }, async () => {
  const [a, b] = await Promise.all([launchChrome(chromePath, 9396), launchChrome(chromePath, 9396)]);
  try {
    assert.notEqual(a.port, b.port);
    assert.equal(await evaluate(a.target, '1 + 1'), 2);
    assert.equal(await evaluate(b.target, '2 + 2'), 4);
  } finally { a.kill(); b.kill(); }
});
