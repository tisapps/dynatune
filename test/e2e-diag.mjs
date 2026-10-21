// Browser-Test Diagnose-Aufnahme: Aufnahme starten, beide Dateien herunterladen,
// mit replay.mjs nachspielen. node test/e2e-diag.mjs (Port 8771)
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(path.join(os.tmpdir(), 'dynatune-diag-'));
const wav = path.join(dir, 'in.wav');
execFileSync('python3', [path.join(root, 'test/make-wav.py'), wav]);
const server = spawn('python3', ['-m', 'http.server', '8771', '-d', root], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8771/?echotest=0.5&diagsec=5');
await page.click('#start');
await page.waitForFunction(() => window.dynatune.state === 'idle', null, { timeout: 15000 });
const downloads = [];
page.on('download', (d) => downloads.push(d));
await page.click('#open-settings');
await page.click('#diag');
await page.waitForFunction(() => !document.getElementById('diag').disabled, null, { timeout: 20000 });
await page.waitForTimeout(500);
const files = [];
for (const d of downloads) { const p = path.join(dir, d.suggestedFilename()); await d.saveAs(p); files.push(p); }
const info = await page.textContent('#diag-info');
await browser.close();
server.kill();
console.log('Diagnose:', info);
for (const f of files) console.log(`  ${path.basename(f)}  ${(statSync(f).size / 1e6).toFixed(2)} MB`);
const w = files.find((f) => f.endsWith('.wav'));
const out = execFileSync('node', [path.join(root, 'test/replay.mjs'), w], { encoding: 'utf8' });
console.log(out);
const ok = files.length === 2 && !errors.length && /Nachgespielt: .*H4/.test(out) && /Gerät: .*H4/.test(out);
if (errors.length) console.log('Fehler im Browser:', errors);
console.log(ok ? 'OK' : 'FEHLER');
process.exit(ok ? 0 : 1);
