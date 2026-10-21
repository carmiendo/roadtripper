import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const sw = readFileSync(new URL('sw.js', root), 'utf8');
const shell = [...sw.slice(sw.indexOf('const SHELL = ['), sw.indexOf('];', sw.indexOf('const SHELL = ['))).matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('every script is saved for offline use', () => {
  const scripts = readdirSync(new URL('js/', root)).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`);
  const missing = scripts.filter((f) => !shell.includes(f));
  assert.deepEqual(missing, [], 'add these to SHELL in sw.js');
});

test('every file in the offline list exists', () => {
  for (const f of shell.filter((f) => f !== './')) readFileSync(new URL(f, root));
});

test('icons in the manifest exist', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', root), 'utf8'));
  for (const icon of manifest.icons) readFileSync(new URL(icon.src, root));
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
});

test('every module is preloaded from index.html', () => {
  const html = readFileSync(new URL('index.html', root), 'utf8');
  const preloaded = [...html.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);
  const modules = readdirSync(new URL('js/', root)).filter((f) => f.endsWith('.js') && f !== 'app.js').map((f) => `js/${f}`);
  assert.deepEqual(modules.filter((f) => !preloaded.includes(f)), [], 'add <link rel="modulepreload"> for these');
});
