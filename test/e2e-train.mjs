// Browser-Test Einlern-Dialog: node test/e2e-train.mjs (Port 8768)
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wav = path.join(os.tmpdir(), 'dynatune-train.wav');
execFileSync('python3', [path.join(root, 'test/make-train-wav.py'), wav]);
const server = spawn('python3', ['-m', 'http.server', '8768', '-d', root], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8768/');
await page.click('#train-main');               // startet Audio automatisch
await page.waitForTimeout(9000);
const progress = await page.textContent('#train-progress');
const log = await page.$$eval('#train-log div', (els) => els.map((e) => e.textContent).reverse());
await page.screenshot({ path: path.join(os.tmpdir(), 'dynatune-train.png') });
await page.click('#train-cancel');
const main = await page.textContent('#train-main-state');
await browser.close();
server.kill();
console.log('Fortschritt:', progress);
console.log('Testergebnisse:', log);
console.log('Hauptbildschirm:', main, errors.length ? errors : '');
const ok = progress.startsWith('Übereinstimmung') && log.length === 3 && log[0].startsWith('✓') && log[1].startsWith('✗') && log[2].startsWith('✓') && main.includes('eingelernt') && !errors.length;
console.log(ok ? 'OK' : 'FEHLER');
process.exit(ok ? 0 : 1);
