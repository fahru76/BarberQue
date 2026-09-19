#!/usr/bin/env node
// Served-surface verification for the 2026-09-19 H1 change (capability-aware
// walk-in estimate + the new "unservable ticket" backstop confirm dialog).
//
// Renders index.html's customer surface hermetically (same harness pattern as
// tests/dom/fingerprint.mjs: http:// stub origin, local files from disk,
// Supabase CDN stubbed) at desktop / tablet / mobile, drives the walk-in
// service picker so the estimate preview renders, and forces the new backstop
// confirm dialog open. For each it reports concrete layout evidence: element
// boxes, whether text overflows/clips its container, and the visible copy.
//
// This is EVIDENCE GATHERING, not a pass/fail visual-QA gate -- it prints
// observations for a human to judge.
//
// Usage:  node tests/dom/walkin-surface.verify.mjs
//         QC_BROWSER_CHANNEL=msedge node tests/dom/walkin-surface.verify.mjs

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
  for (const name of ['playwright', 'playwright-core']) {
    try { return require(name); } catch { /* not a local install */ }
  }
  const cache = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache)) {
      const p = path.join(cache, dir, 'node_modules', 'playwright');
      if (existsSync(p)) return require(p);
    }
  }
  throw new Error('Playwright not found.');
}
const { chromium } = loadPlaywright();

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

const SUPABASE_STUB = `
export function createClient() {
  const empty = async () => ({ data: [], error: null });
  const builder = { select: () => builder, eq: () => builder, order: () => builder,
                    limit: empty, maybeSingle: async () => ({ data: null, error: null }),
                    single: async () => ({ data: null, error: null }) };
  return {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signInWithPassword: empty, signOut: empty, resetPasswordForEmail: empty
    },
    from: () => builder,
    rpc: empty,
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), unsubscribe() {} }),
    removeChannel: () => {}
  };
}
export default { createClient };
`;

// Two services so the multi-service capability path is exercisable.
const SEED_SERVICES = [
  { id: 'SVC-A', name: 'Gunting Biasa', price: 20, duration: 30, active: true, category: 'asas', target: 'semua', type: 'gunting', sortOrder: 0, styleNotes: '', imageUrlFront: '', imageUrlBack: '' },
  { id: 'SVC-B', name: 'Perm Rambut', price: 80, duration: 90, active: true, category: 'asas', target: 'semua', type: 'lain', sortOrder: 1, styleNotes: '', imageUrlFront: '', imageUrlBack: '' }
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'mobile', width: 390, height: 844 }
];

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
      if (file.startsWith(ROOT) && existsSync(file)) {
        return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] || 'application/octet-stream', body: readFileSync(file) });
      }
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 200, body: '' });
  });

  // Seed services + an open shop + TWO OPEN SEATS before app code reads them.
  // (Without activeSeats every chair is closed and the ETA is legitimately
  // "Belum dapat dianggarkan" -- not what we're verifying here.)
  await page.addInitScript(({ services }) => {
    localStorage.setItem('shopServices', JSON.stringify(services));
    localStorage.setItem('shopStatus', 'open');
    localStorage.setItem('queues', JSON.stringify([]));
    localStorage.setItem('appointments', JSON.stringify([]));
    localStorage.setItem('maxQueue', '10');
    localStorage.setItem('activeSeats', JSON.stringify({ 1: true, 2: true }));
    // An active seat must have a barber assignment or the boot-time
    // normalizeActiveSeatsForAssignments() invariant (seats_active_requires_barber)
    // flips it back off -- seed names so the chairs genuinely stay open.
    localStorage.setItem('barberAssignments', JSON.stringify({ 1: 'Ali', 2: 'Bala' }));
    // Force the customer view.
    if (!location.search.includes('view=')) {
      history.replaceState(null, '', '?view=customer');
    }
  }, { services: SEED_SERVICES });

  await page.goto(`${ORIGIN}/index.html?view=customer`, { waitUntil: 'load' });
  await page.waitForTimeout(700);

  const out = { viewport: vp.name, width: vp.width, pageErrors: errors };

  // ---- 1. Walk-in ETA preview after selecting both services ---------------
  const preview = await page.evaluate(() => {
    const cbs = Array.from(document.querySelectorAll('input[name="walkinServices"]'));
    cbs.forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); });
    const eta = document.getElementById('walkinQueueEta');
    const etaLabel = document.getElementById('walkinQueueEtaLabel');
    const summary = document.getElementById('walkinServiceSummary');
    const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const overflow = el => el ? (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) : null;
    return {
      checkboxCount: cbs.length,
      checkedCount: cbs.filter(c => c.checked).length,
      etaText: eta ? eta.innerText : null,
      etaLabelText: etaLabel ? etaLabel.innerText : null,
      etaBox: box(eta),
      etaOverflow: overflow(eta),
      summaryHtml: summary ? summary.innerText : null
    };
  });
  out.walkinPreview = preview;

  // ---- 2. The new backstop confirm dialog ---------------------------------
  // Drive it through the same code path bookTicketImpl uses: showConfirmDialog
  // with the exact H1 message + title.
  await page.evaluate(() => {
    window.showConfirmDialog(
      'Maaf, tiada tukang gunting yang boleh membuat servis ini sebelum kedai tutup hari ini.',
      { title: 'Tidak Sempat Hari Ini' }
    );
  });
  await page.waitForTimeout(150);
  const dialog = await page.evaluate(() => {
    const dlg = document.getElementById('appConfirmDialog');
    const title = document.getElementById('appConfirmDialogTitle');
    const msg = document.getElementById('appConfirmDialogMessage');
    const okBtn = document.getElementById('appConfirmDialogOkBtn');
    const cancelBtn = document.getElementById('appConfirmDialogCancelBtn');
    const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const overflow = el => el ? (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) : null;
    const visible = el => { if (!el) return false; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    return {
      open: dlg ? (dlg.open || dlg.hasAttribute('open')) : null,
      visible: visible(dlg),
      titleText: title ? title.textContent : null,
      messageText: msg ? msg.messageText || msg.textContent : null,
      dialogBox: box(dlg),
      messageBox: box(msg),
      messageOverflow: overflow(msg),
      dialogOverflowX: dlg ? dlg.scrollWidth > dlg.clientWidth + 1 : null,
      okText: okBtn ? okBtn.textContent : null,
      cancelText: cancelBtn ? cancelBtn.textContent : null,
      viewportW: window.innerWidth,
      dialogFitsHorizontally: dlg ? (() => { const r = dlg.getBoundingClientRect(); return r.x >= 0 && r.right <= window.innerWidth + 1; })() : null
    };
  });
  out.backstopDialog = dialog;
  await page.screenshot({ path: path.join(HERE, `.verify-walkin-${vp.name}.png`) });

  await context.close();
  return out;
}

const browser = await chromium.launch();
const results = [];
for (const vp of VIEWPORTS) results.push(await run(browser, vp));
await browser.close();

console.log(JSON.stringify(results, null, 2));
