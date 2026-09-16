#!/usr/bin/env node
// Rendered-DOM fingerprint — the gate for the no-visual-change phases
// (Phase 0 token consolidation, Phase 1 scale swaps) in docs/DESIGN_BLUEPRINT.md.
//
// TWO lessons are baked in here, both learned by getting them wrong first:
//
// 1. THEME MUST BE DETERMINISTIC. index.html's applyTheme() (:4909) resolves the
//    theme from a stored/auto value and can run asynchronously AFTER load. A
//    post-load setAttribute() therefore races it -- the first version of this
//    harness set data-theme, waited, then read, and every dark run was silently
//    overwritten to the same resolved theme as light. Both hashed identically,
//    which is a harness that measures nothing. Fix: set data-theme AND read
//    computed styles inside ONE synchronous page.evaluate(), so no async boot
//    code can interleave. colourScheme is also pinned on the context.
//
// 2. THE CONTRACT IS THE TOKEN LAYER, NOT EVERY PIXEL. Phase 0's claim is "no
//    token value moved". A full-document style hash tests far more than that and
//    is brittle; the token map is the exact invariant the change threatens. Both
//    are captured and hashed, but the token map is the one that must not move.
//
// Loads index.html over an http:// stub origin (file:// blocks ES module
// imports), serves local files from disk, stubs the Supabase CDN import, and
// hashes in Node -- never inside page.evaluate -- so results are byte-stable.
//
// Usage:
//   node tests/dom/fingerprint.mjs --out .fingerprint-before.json
//   node tests/dom/fingerprint.mjs --compare .fingerprint-before.json
//
// Playwright is resolved from $PW_MODULE, a local install, or the newest
// package under %LOCALAPPDATA%/npm-cache/_npx/*/node_modules/. It is
// deliberately NOT a package.json dependency: index.html has no build step and
// must keep none.

import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  throw new Error('Playwright not found. Install it or set PW_MODULE to the playwright package directory.');
}

const { chromium } = loadPlaywright();

const PROPS = [
  'color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight',
  'letterSpacing', 'textTransform', 'borderTopColor', 'borderTopWidth',
  'borderTopLeftRadius', 'paddingTop', 'paddingLeft', 'marginTop',
  'display', 'position', 'boxShadow', 'opacity'
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'mobile', width: 390, height: 844 }
];

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

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json'
};

async function capture(browser, viewport, theme) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme === 'light' ? 'light' : 'dark'
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message ? e.message : e)));

  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'esm.sh') {
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: SUPABASE_STUB });
    }
    if (url.origin === ORIGIN) {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(ROOT, rel);
      if (file.startsWith(ROOT) && existsSync(file)) {
        return route.fulfill({
          status: 200,
          contentType: MIME[path.extname(file)] || 'application/octet-stream',
          body: readFileSync(file)
        });
      }
      return route.fulfill({ status: 404, body: '' });
    }
    // Fonts, maps, analytics: empty 200 keeps the run hermetic and offline.
    return route.fulfill({ status: 200, body: '' });
  });

  await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'load' });
  // Let the boot sequence (initData/updateUI/auth) settle before sampling.
  await page.waitForTimeout(500);

  // Theme set and read in ONE synchronous evaluate — nothing can interleave.
  const snap = await page.evaluate(({ props, theme }) => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    const rootCS = getComputedStyle(root);

    const tokenNames = new Set();
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        const st = rule.style;
        if (!st) continue;
        for (const name of st) if (name.startsWith('--')) tokenNames.add(name);
      }
    }
    const tokens = {};
    for (const n of [...tokenNames].sort()) tokens[n] = rootCS.getPropertyValue(n).trim();

    const rows = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const row = { t: el.tagName, i: el.id || '', c: typeof el.className === 'string' ? el.className : '' };
      for (const p of props) row[p] = cs[p];
      rows.push(row);
    }
    return { theme, tokenCount: Object.keys(tokens).length, tokens, rows };
  }, { props: PROPS, theme });

  await context.close();

  const tokenHash = createHash('sha256').update(JSON.stringify(snap.tokens)).digest('hex');
  const styleHash = createHash('sha256').update(JSON.stringify(snap.rows)).digest('hex');
  return { tokenCount: snap.tokenCount, tokens: snap.tokens, tokenHash, styleHash, elements: snap.rows.length, errors };
}

const arg = name => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
};
const compareFile = arg('--compare');
const outFile = arg('--out');

const browser = await chromium.launch();
const result = {};
for (const vp of VIEWPORTS) {
  for (const theme of ['dark', 'light']) {
    const key = `${theme}-${vp.name}`;
    result[key] = await capture(browser, vp, theme);
    const r = result[key];
    console.log(`${key.padEnd(16)} tokens=${String(r.tokenCount).padEnd(4)} tokenHash=${r.tokenHash.slice(0, 12)} styleHash=${r.styleHash.slice(0, 12)} els=${String(r.elements).padEnd(5)} errors=${r.errors.length}`);
  }
}
await browser.close();

// Self-check: a harness that cannot tell dark from light cannot detect
// anything. Fail loudly rather than emit a green-looking baseline.
let themeBlind = 0;
for (const vp of VIEWPORTS) {
  if (result[`dark-${vp.name}`].tokenHash === result[`light-${vp.name}`].tokenHash) themeBlind++;
}
if (themeBlind > 0) {
  console.log(`\nSELF-CHECK FAILED: dark and light tokens are identical at ${themeBlind} viewport(s). The harness is theme-blind; results are meaningless.`);
  process.exit(2);
}

if (outFile) {
  writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  console.log(`\nbaseline written to ${outFile}`);
}

if (compareFile) {
  const before = JSON.parse(readFileSync(compareFile, 'utf8'));
  let mismatches = 0;
  for (const key of Object.keys(result)) {
    const a = before[key], b = result[key];
    if (!a) { console.log(`MISSING baseline for ${key}`); mismatches++; continue; }
    if (a.tokenHash !== b.tokenHash) { console.log(`TOKEN MISMATCH ${key}: ${a.tokenHash.slice(0,12)} -> ${b.tokenHash.slice(0,12)}`); mismatches++; }
    if (a.styleHash !== b.styleHash) { console.log(`STYLE MISMATCH ${key}: ${a.styleHash.slice(0,12)} -> ${b.styleHash.slice(0,12)}`); mismatches++; }
  }
  console.log(mismatches === 0
    ? '\nPASS - token layer and rendered styles identical across all 6 runs.'
    : `\nFAIL - ${mismatches} mismatch(es).`);
  process.exit(mismatches === 0 ? 0 : 1);
}