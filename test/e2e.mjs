// Browser-Test: node test/e2e.mjs  (startet eigenen Webserver auf Port 8765)
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

// Playwright aus dem Projekt oder aus PLAYWRIGHT_MODULE (Pfad zu playwright/index.mjs)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wav = path.join(os.tmpdir(), 'dynatune-test.wav');
execFileSync('python3', [path.join(root, 'test/make-wav.py'), wav]);
const server = spawn('python3', ['-m', 'http.server', '8765', '-d', root], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const ECHO = process.env.ECHO || '';
await page.goto('http://localhost:8765/' + (ECHO ? `?echotest=${ECHO}` : ''));

// Stoppsignal-Vorlage aus einem synthetischen Schnalzer erzeugen
await page.evaluate(async () => {
  const { features, buildTemplate } = await import('/js/stopsignal.js');
  const fs = 48000, list = [];
  for (let k = 0; k < 4; k++) {
    const b = new Float32Array(4352);
    for (let i = 0; i < 1440; i++) b[256 + i] = 0.6 * Math.exp(-i / 96) * (Math.random() * 2 - 1);
    list.push(features(b, fs));
  }
  window.dynatune.settings.stopTemplate = buildTemplate(list);
});

await page.click('#start');
const t0 = Date.now();
const log = [];
let shot = false;
while (Date.now() - t0 < 9000) {
  const s = await page.evaluate(() => ({ st: window.dynatune.state, n: window.dynatune.currentNote, f: window.dynatune.refFreq, p: window.dynatune.lastPitch, cents: document.getElementById('cents').textContent }));
  const last = log.at(-1);
  if (!last || last.st !== s.st || last.n !== s.n || last.cents.includes('außerhalb') !== s.cents.includes('außerhalb')) log.push({ t: Date.now() - t0, ...s });
  if (!shot && Date.now() - t0 > 3900) { shot = true; await page.screenshot({ path: path.join(os.tmpdir(), 'dynatune-tracking.png') }); }
  await page.waitForTimeout(10);
}
console.log('Stoppsignal:', await page.textContent('#stop-last'));
console.log('Einmessen:', await page.textContent('#echo-info'));
await page.click('#open-settings');
await page.screenshot({ path: path.join(os.tmpdir(), 'dynatune-settings.png'), fullPage: true });
for (const l of log) console.log(`${String(l.t).padStart(5)} ms  ${l.st.padEnd(9)} Note ${l.n ?? '–'}  Ref ${l.f ? l.f.toFixed(2) : '–'} Hz  ${l.cents}`);
await browser.close();
server.kill();

const seq = log.map((l) => `${l.st}:${l.n ?? ''}`);
const want = ['calib:', 'idle:', 'tracking:69', 'tracking:71', 'hold:71', 'idle:'];
let i = 0;
for (const s of seq) if (s === want[i]) i++;
const gray = log.some((l) => l.cents.includes('außerhalb') && l.n === 71);
if (errors.length) console.log('Fehler im Browser:', errors);
console.log(i === want.length && gray && !errors.length ? 'OK' : `FEHLER: erwartet ${want.join(' → ')} + Graubereich`);
process.exit(i === want.length && gray && !errors.length ? 0 : 1);
