// ════════════════════════════════════════════════════════════════════════════
// ONE CHROME LAUNCHER FOR EVERY RVP CHROME TEST (2026-09-30, Q14; after
// diagnostix-evp 24ea3c7).
//
// THE PORT IS CHOSEN BY CHROME, NEVER BY THE CALLER. Each test used to launch
// Chrome on a fixed debugging port and take the first page listed there; when
// another suite's Chrome (or anything) already held that port, the new Chrome
// could not bind it and the test drove the OTHER process's page
// (test/chrome-port.test.js). Now Chrome binds port 0 and writes the port it
// took to DevToolsActivePort in its own, fresh profile directory, which only
// this process can have written. The port argument is accepted and ignored.
//
// Lives outside test/ because node --test runs every file under test/.
// ════════════════════════════════════════════════════════════════════════════
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

// Returns { port, target, kill }. target is the page's /json entry (with
// webSocketDebuggerUrl), or null when Chrome exposed none; the caller asserts.
export async function launchChrome(chromePath, _portIgnored) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvp-chrome-'));
  const proc = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  const kill = () => { try { proc.kill(); } catch { /* gone */ } };
  let port = null;
  for (let i = 0; i < 150 && !port; i++) {
    try {
      const first = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
      if (/^\d+$/.test(first)) port = Number(first);
    } catch { /* not written yet */ }
    if (!port) await sleep(100);
  }
  if (!port) return { port: null, target: null, kill };
  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    try { const list = await getJSON('http://127.0.0.1:' + port + '/json');
      target = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl) || null; } catch { /* not up */ }
    if (!target) await sleep(200);
  }
  return { port, target, kill };
}
