// Kanban board DOM test (kanban slice 2).
//
// Verifies the read-only board in #kanbanPanel renders from js/domain/
// kanbanState.js against injected localStorage state -- without a server:
// the page is loaded over an http:// stub origin (file:// blocks ES module
// imports), local files served from disk, Supabase CDN stubbed, exactly like
// tests/dom/fingerprint.mjs. Then synthetic queues/seats are written into
// localStorage, updateUI() re-run, and the DOM asserted.
//
// Usage:
//   QC_BROWSER_CHANNEL=msedge node tests/dom/kanban-dom.test.mjs
//   (PW_MODULE resolves Playwright the same way fingerprint.mjs does)

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
  throw new Error('Playwright not found. Install it or set PW_MODULE to the playwright package directory.');
}

const { chromium } = loadPlaywright();

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

// Synthetic today-state: 2 seats configured on the server (1 active w/ Syam,
// 2 closed), plus a third legacy local seat. Tickets: two waiting (one
// fast-pass, later timestamp), one serving on seat 1, one completed and one
// cancelled on seat 1 (counts, not cards).
const SEED = {
  seatCount: '3',
  seatServerState: [
    { seatNo: 1, active: true, barberId: 'u1', barberName: 'Syam' },
    { seatNo: 2, active: false, barberId: null, barberName: null }
  ],
  queues: [
    { id: 'W1', name: 'W-12', service: 'Potong', duration: 30, seat: null, barberId: null, status: 'waiting', queueSource: 'walkin', isFastPass: false, timestamp: '2026-09-18T02:00:00.000Z', calledAt: null },
    { id: 'W2', name: 'W-13', service: 'Cukur', duration: 20, seat: null, barberId: null, status: 'waiting', queueSource: 'walkin', isFastPass: true, timestamp: '2026-09-18T02:10:00.000Z', calledAt: null },
    { id: 'S1', name: 'W-11', service: 'Potong', duration: 30, seat: 1, barberId: 'u1', status: 'serving', queueSource: 'walkin', isFastPass: false, timestamp: '2026-09-18T01:30:00.000Z', calledAt: '2026-09-18T01:35:00.000Z' },
    { id: 'D1', name: 'W-05', service: 'Potong', duration: 30, seat: 1, barberId: 'u1', status: 'completed', queueSource: 'walkin', isFastPass: false, timestamp: '2026-09-18T00:30:00.000Z', calledAt: '2026-09-18T00:35:00.000Z', completedAt: '2026-09-18T01:05:00.000Z' },
    { id: 'X1', name: 'W-06', service: 'Cukur', duration: 20, seat: 1, barberId: 'u1', status: 'cancelled', queueSource: 'walkin', isFastPass: false, timestamp: '2026-09-18T00:40:00.000Z', calledAt: null }
  ]
};

let passed = 0, failed = [];
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  pass  ${name}`); }
  else { failed.push(name); console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`); };
};

const browser = await chromium.launch(process.env.QC_BROWSER_CHANNEL ? { channel: process.env.QC_BROWSER_CHANNEL } : {});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e && e.message ? e.message : e)));

await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.hostname === 'esm.sh') {
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: SUPABASE_STUB });
  }
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

await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'load' });
await page.waitForTimeout(500);

// Inject today-state into localStorage the way the app itself stores it, then
// re-run the render pipeline. seatServerState is a module variable fed by
// refreshSeatServerState(); there is no setter, so we call the function over a
// stubbed SeatRepo.listSeats instead of poking the variable directly.
await page.evaluate(seed => {
  localStorage.setItem('seatCount', seed.seatCount);
  localStorage.setItem('queues', JSON.stringify(seed.queues));
}, SEED);
await page.evaluate(seats => {
  window.SeatRepo.listSeats = async () => seats;
}, SEED.seatServerState);
await page.evaluate(() => window.refreshSeatServerState?.());
await page.waitForTimeout(200);
await page.evaluate(() => window.updateUI?.());
await page.waitForTimeout(200);

const board = await page.evaluate(() => {
  const boardEl = document.getElementById('kanbanBoard');
  if (!boardEl) return null;
  const columns = [...boardEl.querySelectorAll('.kanban-col')].map(col => ({
    id: col.dataset.columnId,
    label: col.querySelector('.kanban-col-head span')?.textContent,
    count: col.querySelector('.kanban-col-count')?.textContent,
    closed: col.classList.contains('kanban-col-closed'),
    cards: [...col.querySelectorAll('.kanban-card')].map(card => ({
      id: card.dataset.queueId,
      num: card.querySelector('.kanban-card-num')?.textContent,
      fastpass: card.classList.contains('kanban-card-fastpass')
    })),
    empty: !!col.querySelector('.kanban-empty')
  }));
  return { columns, panelVisibleInBarberView: !!boardEl.closest('#barber-app') };
});

eq('no page errors during render', pageErrors.length, 0);
ok_board: {
  if (!board) { eq('kanban board exists', null, 'missing'); break ok_board; }
  eq('columns: waiting first, then seats 1..3', board.columns.map(c => c.id),
    ['__waiting__', 'seat:1', 'seat:2', 'seat:3']);
  eq('column labels (barber name on seat 1, KURSI fallback elsewhere)',
    board.columns.map(c => c.label), ['MENUNGGU', 'Syam', 'KURSI 2', 'KURSI 3']);
  eq('closed seats flagged in DOM (seat 3 has no server row -> closed)',
    board.columns.map(c => c.closed), [false, false, true, true]);
  eq('waiting column: fast-pass first despite later timestamp',
    board.columns[0].cards.map(c => c.id), ['W2', 'W1']);
  eq('serving card sits in seat:1', board.columns[1].cards.map(c => c.id), ['S1']);
  eq('seats 2..3 empty (— placeholders)', [board.columns[2].empty, board.columns[3].empty], [true, true]);
  eq('doneCount shows as "selesai N" on seat:1', board.columns[1].count, '1 · selesai 2');
  eq('card shows ticket number', board.columns[0].cards[0].num, 'W-13');
  eq('fast-pass card styled', board.columns[0].cards[0].fastpass, true);
  eq('board lives inside the barber panel', board.panelVisibleInBarberView, true);
}
// XSS probe: a ticket name containing HTML must render as text, not markup.
await page.evaluate(() => {
  const queues = JSON.parse(localStorage.getItem('queues'));
  queues.push({ id: 'XSS1', name: '<img src=x onerror=window.__pwned=1>', service: 'Potong', duration: 30, seat: null, barberId: null, status: 'waiting', queueSource: 'walkin', isFastPass: false, timestamp: '2026-09-18T02:20:00.000Z', calledAt: null });
  localStorage.setItem('queues', JSON.stringify(queues));
  window.updateUI?.();
});
await page.waitForTimeout(200);
const xss = await page.evaluate(() => ({
  pwned: !!window.__pwned,
  asText: [...document.querySelectorAll('#kanbanBoard .kanban-card-num')].some(el => el.textContent.includes('<img')),
  injectedImg: !!document.querySelector('#kanbanBoard img')
}));
eq('XSS probe: hostile name rendered as inert text', [xss.pwned, xss.injectedImg], [false, false]);
eq('XSS probe: name visible as text (not dropped)', xss.asText, true);

await browser.close();
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.error(failed.join('\n')); process.exit(1); }
