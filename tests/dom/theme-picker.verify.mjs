#!/usr/bin/env node
// Served-surface verification for the theme PICKER UI itself (2026-09-19).
// The changed rendered element is <select id="themeSelector">, now holding 9
// options with longer Malay labels (e.g. "Royal Blue — Gelap") inside
// <optgroup>s. This inspects, at desktop + mobile:
//   1. the CLOSED selector: does the selected label fit, or is it truncated
//      (min-width:92px + font-size:.75rem is a real truncation risk)?
//   2. the OPEN dropdown: do optgroup labels + options render, with the current
//      option marked selected?
//   3. text layout of representative surfaces under each scheme (any clipped/
//      overflowing text in the customer ticket panel)?
//   4. interaction: keyboard focus + change via the real onchange path.
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ORIGIN = 'http://qc.test';
function loadPlaywright(){ if(process.env.PW_MODULE)return require(process.env.PW_MODULE); for(const n of ['playwright','playwright-core']){try{return require(n)}catch{}} const c=path.join(process.env.LOCALAPPDATA||'','npm-cache','_npx'); if(existsSync(c))for(const d of readdirSync(c)){const p=path.join(c,d,'node_modules','playwright'); if(existsSync(p))return require(p);} throw new Error('Playwright not found.'); }
const { chromium } = loadPlaywright();
const MIME = { '.html':'text/html','.js':'application/javascript','.mjs':'application/javascript' };
const STUB = `export function createClient(){const e=async()=>({data:[],error:null});const b={select:()=>b,eq:()=>b,order:()=>b,limit:e,maybeSingle:async()=>({data:null,error:null}),single:async()=>({data:null,error:null})};return{auth:{getSession:async()=>({data:{session:null},error:null}),getUser:async()=>({data:{user:null},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:()=>b,rpc:e,channel:()=>({on:()=>({subscribe:()=>({})})}),removeChannel:()=>{}};}export default {createClient};`;

const SELECTOR_LABELS = ['Royal Blue — Gelap', 'Royal Blue — Cerah', 'Forest — Gelap', 'Teal — Cerah', 'Emas — Gelap'];

async function run(browser, vp) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message ? e.message : e)));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'esm.sh') return route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB });
    if (url.origin === ORIGIN) {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const f = path.resolve(ROOT, rel);
      if (f.startsWith(ROOT) && existsSync(f)) return route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || 'application/octet-stream', body: readFileSync(f) });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 200, body: '' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('shopServices', JSON.stringify([{ id: 'SVC-A', name: 'Gunting Biasa', price: 20, duration: 30, active: true, category: 'asas', target: 'semua', type: 'gunting', sortOrder: 0 }]));
    localStorage.setItem('shopStatus', 'open'); localStorage.setItem('queues', '[]'); localStorage.setItem('appointments', '[]');
    localStorage.setItem('activeSeats', JSON.stringify({ 1: true, 2: true })); localStorage.setItem('barberAssignments', JSON.stringify({ 1: 'Ali', 2: 'Bala' }));
  });
  await page.goto(`${ORIGIN}/index.html?view=customer`, { waitUntil: 'load' });
  await page.waitForTimeout(650);

  const out = { viewport: vp.name, width: vp.width, pageErrors: errors };

  // ---- 1. Closed selector geometry + option inventory ---------------------
  out.selector = await page.evaluate(() => {
    const sel = document.getElementById('themeSelector');
    const r = sel.getBoundingClientRect();
    const cs = getComputedStyle(sel);
    // measure the rendered text width of the longest option by setting it selected
    const groups = Array.from(sel.querySelectorAll('optgroup')).map(g => ({ label: g.label, options: Array.from(g.querySelectorAll('option')).map(o => o.textContent.trim()) }));
    return {
      width: Math.round(r.width), minWidth: cs.minWidth, fontSize: cs.fontSize,
      optionCount: sel.querySelectorAll('option').length,
      optgroupCount: groups.length,
      groups,
      visible: cs.display !== 'none' && r.width > 0 && r.height > 0
    };
  });

  // For each long label: select it (real onchange path) and measure whether the
  // closed control shows it in full (scrollWidth of the select vs clientWidth is
  // not reliable on <select>, so measure via a canvas of the same font).
  out.closedSelectorFit = await page.evaluate((labels) => {
    const sel = document.getElementById('themeSelector');
    const cs = getComputedStyle(sel);
    const canvas = document.createElement('canvas').getContext('2d');
    canvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const padLeft = parseFloat(cs.paddingLeft), padRight = parseFloat(cs.paddingRight);
    const innerWidth = sel.clientWidth - padLeft - padRight;
    return labels.map(label => {
      const opt = Array.from(sel.options).find(o => o.text.trim() === label);
      if (!opt) return { label, found: false };
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const textW = canvas.measureText(label).width;
      return { label, found: true, selected: sel.value === opt.value, textWidth: Math.round(textW), innerWidth: Math.round(innerWidth), fits: textW <= innerWidth + 1 };
    });
  }, SELECTOR_LABELS);

  // ---- 2. The OPEN dropdown (optgroup list) -------------------------------
  // Focus + open via keyboard (ArrowDown) is the closest we can get headlessly;
  // native popup rendering isn't capturable, but focusability + selectedIndex is.
  await page.focus('#themeSelector');
  out.selectorFocusable = await page.evaluate(() => document.activeElement === document.getElementById('themeSelector'));
  await page.screenshot({ path: path.join(HERE, `.verify-picker-${vp.name}.png`) });

  // ---- 3. Text layout of a representative surface under each scheme --------
  // The customer ticket panel is the most text-dense surface; check for overflow.
  out.surfaceTextLayout = [];
  for (const val of ['teal:dark', 'royal:light']) {
    const m = await page.evaluate(async (val) => {
      window.changeTheme(val);
      await new Promise(r => setTimeout(r, 70));
      const panel = document.getElementById('customer-take-ticket');
      let clipped = [];
      if (panel) {
        const pr = panel.getBoundingClientRect();
        for (const el of panel.querySelectorAll('h2, h3, p, strong, span, label, button')) {
          const range = document.createRange(); range.selectNodeContents(el);
          const ink = range.getBoundingClientRect();
          if (ink.width === 0 && ink.height === 0) continue;
          if (ink.left < pr.left - 1 || ink.right > pr.right + 1) { clipped.push(el.tagName + '.' + (el.className || '').toString().split(' ')[0] + ':' + el.textContent.trim().slice(0, 24)); if (clipped.length > 3) break; }
        }
      }
      const scheme = document.documentElement.getAttribute('data-scheme');
      const theme = document.documentElement.getAttribute('data-theme');
      const panelBg = panel ? getComputedStyle(panel).backgroundColor : null;
      const panelColor = panel ? getComputedStyle(panel).color : null;
      return { val, scheme, theme, panelBg, panelColor, clippedCount: clipped.length, clipped };
    }, val);
    out.surfaceTextLayout.push(m);
    await page.screenshot({ path: path.join(HERE, `.verify-surface-${val.replace(':', '-')}-${vp.name}.png`) });
  }

  await ctx.close();
  return out;
}

const browser = await chromium.launch();
const results = [];
for (const vp of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) results.push(await run(browser, vp));
await browser.close();
console.log(JSON.stringify(results, null, 2));
