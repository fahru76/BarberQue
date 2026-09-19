#!/usr/bin/env node
// Served-surface verification for the .app-dialog centring change (2026-09-19).
//
// Renders index.html hermetically (stub origin, local files, Supabase stubbed —
// same pattern as tests/dom/fingerprint.mjs) and opens the app's three most
// representative dialog types through their REAL open functions:
//   - appAlertDialog   (showAlertDialog)  — single button, short content
//   - appConfirmDialog (showConfirmDialog) — two buttons, medium content
//   - staffLoginDialog (openStaffLoginDialog) — a FORM with two inputs (tallest,
//     the best stress test for vertical centring + keyboard/interaction)
// For each, at desktop 1440 and mobile 390, it measures: open/visible, exact
// centering on both axes, fits-in-viewport (no negative-margin clipping), text
// overflow/clipping, and that the primary interactive control is reachable
// (receives focus). Screenshots are written alongside for the record.
//
// Usage: node tests/dom/dialog-centering.verify.mjs
//        QC_BROWSER_CHANNEL=msedge node tests/dom/dialog-centering.verify.mjs

import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ORIGIN = 'http://qc.test';

function loadPlaywright() {
  if (process.env.PW_MODULE) return require(process.env.PW_MODULE);
  for (const name of ['playwright', 'playwright-core']) { try { return require(name); } catch { } }
  const cache = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  if (existsSync(cache)) for (const dir of readdirSync(cache)) { const p = path.join(cache, dir, 'node_modules', 'playwright'); if (existsSync(p)) return require(p); }
  throw new Error('Playwright not found.');
}
const { chromium } = loadPlaywright();
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript' };

const SUPABASE_STUB = `
export function createClient() {
  const empty = async () => ({ data: [], error: null });
  const builder = { select: () => builder, eq: () => builder, order: () => builder,
                    limit: empty, maybeSingle: async () => ({ data: null, error: null }),
                    single: async () => ({ data: null, error: null }) };
  return {
    auth: { getSession: async () => ({ data: { session: null }, error: null }),
            getUser: async () => ({ data: { user: null }, error: null }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signInWithPassword: empty, signOut: empty, resetPasswordForEmail: empty },
    from: () => builder, rpc: empty,
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), unsubscribe() {} }),
    removeChannel: () => {}
  };
}
export default { createClient };
`;

// Each entry: the dialog id, a focusable control to test, and an in-page open
// expression (string — Playwright can't serialize function objects as args).
const DIALOGS = [
  { key: 'alert', id: 'appAlertDialog', focusSelector: '#appAlertDialogOkBtn', openExpr: `void window.showAlertDialog('Makluman ujian untuk semakan tataletak dialog.', { title: 'Notis Ujian' })` },
  { key: 'confirm', id: 'appConfirmDialog', focusSelector: '#appConfirmDialogOkBtn', openExpr: `void window.showConfirmDialog('Maaf, tiada tukang gunting yang boleh membuat servis ini sebelum kedai tutup hari ini.', { title: 'Tidak Sempat Hari Ini' })` },
  { key: 'login', id: 'staffLoginDialog', focusSelector: '#staffLoginEmail', openExpr: `window.openStaffLoginDialog()` }
];

async function measureDialog(page, dlg) {
  // Open via the real app path. The open functions return Promises that only
  // resolve on user interaction (button click), so do NOT await the dialog's
  // own promise -- just trigger it and let the DOM update.
  await page.evaluate(`(() => { ${dlg.openExpr}; })()`);
  await page.waitForTimeout(140);
  return page.evaluate(({ id, focusSelector }) => {
    const el = document.getElementById(id);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const round = n => Math.round(n);
    const centered = (a, b) => Math.abs(a - b) <= 2;
    const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;

    // text clipping: any direct text-bearing child whose ink escapes the dialog?
    let textClipped = false;
    for (const child of el.querySelectorAll('h3, p, label, button')) {
      const range = document.createRange();
      range.selectNodeContents(child);
      const ink = range.getBoundingClientRect();
      if (ink.width === 0 && ink.height === 0) continue;
      if (ink.left < r.left - 1 || ink.right > r.right + 1 || ink.top < r.top - 1 || ink.bottom > r.bottom + 1) { textClipped = true; break; }
    }

    // interaction readiness: does the primary control accept focus?
    const ctrl = el.querySelector(focusSelector);
    let focusable = false;
    if (ctrl) { ctrl.focus(); focusable = document.activeElement === ctrl; }

    return {
      id,
      open: el.open || el.hasAttribute('open'),
      visible,
      box: { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) },
      viewport: { vw, vh },
      hGaps: [round(r.x), round(vw - r.right)],
      vGaps: [round(r.top), round(vh - r.bottom)],
      hCentered: centered(r.x, vw - r.right),
      vCentered: centered(r.top, vh - r.bottom),
      fitsInViewport: r.left >= 0 && r.top >= 0 && r.right <= vw + 1 && r.bottom <= vh + 1,
      margin: cs.margin,
      textClipped,
      focusableControl: focusable
    };
  }, dlg);
}

async function closeDialog(page, id) {
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (el && typeof el.close === 'function') el.close(); else if (el) el.removeAttribute('open');
  }, id);
  await page.waitForTimeout(60);
}

async function run(browser, vp) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message ? e.message : e)));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'esm.sh') return route.fulfill({ status: 200, contentType: 'application/javascript', body: SUPABASE_STUB });
    if (url.origin === ORIGIN) {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(ROOT, rel);
      if (file.startsWith(ROOT) && existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] || 'application/octet-stream', body: readFileSync(file) });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 200, body: '' });
  });
  await page.goto(`${ORIGIN}/index.html?view=customer`, { waitUntil: 'load' });
  await page.waitForTimeout(650);

  const out = { viewport: vp.name, width: vp.width, height: vp.height, pageErrors: errors, dialogs: [] };
  for (const dlg of DIALOGS) {
    const m = await measureDialog(page, dlg);
    out.dialogs.push(m);
    await page.screenshot({ path: path.join(HERE, `.verify-dialog-${dlg.key}-${vp.name}.png`) });
    await closeDialog(page, dlg.id);
  }
  await context.close();
  return out;
}

const browser = await chromium.launch();
const results = [];
for (const vp of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  results.push(await run(browser, vp));
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
