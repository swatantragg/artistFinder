// Minimal Chrome DevTools Protocol driver (Node 24 global WebSocket). Test tooling only.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launch({ width = 1440, height = 900, port = 9333 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
  const proc = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', `--window-size=${width},${height}`, '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const listeners = [];
  const logs = [];
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
    else if (msg.method) {
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) logs.push(`${msg.params.type}: ${msg.params.args.map(a => a.value ?? a.description).join(' ')}`);
      if (msg.method === 'Runtime.exceptionThrown') logs.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
      for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
  // The one-time "What's new" summary would cover the flows: mark it as switched off in every page.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { localStorage.setItem('artistfinder.whatsNew', 'off'); } catch (e) {}" });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (expr, timeout = 10000, label = expr) => {
    const t = Date.now();
    while (Date.now() - t < timeout) { try { const v = await evaluate(expr); if (v) return v; } catch {} await sleep(100); }
    throw new Error(`Timed out waiting for: ${label}`);
  };
  const text = () => evaluate('document.body.innerText');
  const waitText = (s, timeout = 10000) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, timeout, `text "${s}"`);
  // Click the visible button/link whose text matches (exact first, then startsWith), optionally inside a container selector.
  const click = async (label, within = 'body') => {
    const ok = await evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(within)}) ?? document.body;
      const els = [...root.querySelectorAll('button, a, [role=tab], label, summary')].filter(e => e.offsetParent !== null || e.getClientRects().length);
      const norm = s => s.replace(/\\s+/g, ' ').trim();
      const el = els.find(e => norm(e.innerText) === ${JSON.stringify(label)}) ?? els.find(e => norm(e.innerText).startsWith(${JSON.stringify(label)}));
      if (!el) return false;
      if (el.disabled) return 'disabled';
      el.scrollIntoView({ block: 'center' }); el.click(); return true;
    })()`);
    if (ok === 'disabled') throw new Error(`Button is disabled: ${label}`);
    if (!ok) throw new Error(`Nothing to click: ${label}`);
    await sleep(120);
  };
  // Set a form field by its label text (inputs, selects, textareas inside <label>).
  const fill = async (labelText, value) => {
    const ok = await evaluate(`(() => {
      const dialog = document.querySelector('[role=dialog]') ?? document.body;
      const labels = [...dialog.querySelectorAll('label')];
      const lab = labels.find(l => l.querySelector('span')?.innerText.replace(' *','').trim() === ${JSON.stringify(labelText)});
      const el = lab?.querySelector('input, select, textarea');
      if (!el) return false;
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`No field labelled: ${labelText}`);
    await sleep(60);
  };
  const shot = async (file, full = false) => {
    let clip;
    if (full) {
      const m = await send('Page.getLayoutMetrics');
      const h = await evaluate(`Math.max(...[...document.querySelectorAll('main, body')].map(e => e.scrollHeight))`);
      await send('Emulation.setDeviceMetricsOverride', { width, height: Math.min(h + 60, 6000), deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      void m;
    }
    const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    if (full) await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  };
  const go = async (url) => { await send('Page.navigate', { url }); await sleep(400); };
  const setFile = async (selector, path) => {
    const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
    await send('DOM.setFileInputFiles', { nodeId, files: [path] });
  };
  const clickRow = async (label) => {
    const ok = await evaluate(`(() => { const tr = [...document.querySelectorAll('tbody tr')].find(r => r.innerText.includes(${JSON.stringify(label)})); if (!tr) return false; tr.click(); return true; })()`);
    if (!ok) throw new Error(`No row with: ${label}`);
    await sleep(150);
  };
  const close = () => { try { ws.close(); } catch {} proc.kill('SIGKILL'); };
  const resize = async (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  return { clickRow, send, evaluate, waitFor, waitText, text, click, fill, shot, go, setFile, close, sleep, logs, resize };
}
