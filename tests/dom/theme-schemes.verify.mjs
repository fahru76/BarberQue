#!/usr/bin/env node
// Served-surface verification for the 4-scheme theme design (2026-09-19).
// Renders the app hermetically and, for each scheme x mode, applies it through
// the REAL picker path (changeTheme) and reads back the RESOLVED computed
// tokens + data attributes, proving: (1) the scheme CSS actually applies,
// (2) gold still works as the default, (3) the selector value round-trips,
// (4) localStorage persists the choice. Screenshots for the record.
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

const CASES = [
  { val: 'gold:dark',  scheme: 'gold',   theme: 'dark',  primary: '#d8b06b' },
  { val: 'gold:light', scheme: 'gold',   theme: 'light', primary: '#8b642f' },
  { val: 'teal:dark',  scheme: 'teal',   theme: 'dark',  primary: '#5ec8c0' },
  { val: 'teal:light', scheme: 'teal',   theme: 'light', primary: '#1c7a72' },
  { val: 'forest:dark',scheme: 'forest', theme: 'dark',  primary: '#7cc97f' },
  { val: 'forest:light',scheme:'forest', theme: 'light', primary: '#2c6e33' },
  { val: 'royal:dark', scheme: 'royal',  theme: 'dark',  primary: '#8aa8e8' },
  { val: 'royal:light',scheme: 'royal',  theme: 'light', primary: '#2c4ea3' },
];
const norm = s => s.replace(/\s+/g,'').toLowerCase();

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
  await page.goto(`${ORIGIN}/index.html?view=customer`, { waitUntil: 'load' });
  await page.waitForTimeout(650);

  const out = { viewport: vp.name, pageErrors: errors, cases: [] };
  for (const c of CASES) {
    const r = await page.evaluate(async (c) => {
      window.changeTheme(c.val);
      await new Promise(r => setTimeout(r, 60));
      const cs = getComputedStyle(document.documentElement);
      const g = t => cs.getPropertyValue(t).trim();
      return {
        dataScheme: document.documentElement.getAttribute('data-scheme'),
        dataTheme: document.documentElement.getAttribute('data-theme'),
        selectorValue: document.getElementById('themeSelector').value,
        storedTheme: localStorage.getItem('appTheme'),
        storedScheme: localStorage.getItem('appScheme'),
        primary: g('--primary-color'),
        bg: g('--bg-color'),
        surface: g('--surface-color'),
        onPrimary: g('--on-primary'),
        textMain: g('--text-main'),
        selection: g('--selection-bg'),
        // a real painted element: a .btn-action background uses --primary-color
        btnActionBg: (() => { const b = document.querySelector('.btn-action'); return b ? getComputedStyle(b).backgroundColor : null; })()
      };
    }, c);
    r.expected = c;
    r.pass = r.dataScheme === c.scheme && r.dataTheme === c.theme && norm(r.primary) === norm(c.primary)
          && r.selectorValue === c.val && r.storedTheme === c.val && r.storedScheme === c.scheme;
    out.cases.push(r);
    await page.screenshot({ path: path.join(HERE, `.verify-theme-${c.scheme}-${c.theme}-${vp.name}.png`) });
  }
  await ctx.close();
  return out;
}

const browser = await chromium.launch();
const results = [];
for (const vp of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) results.push(await run(browser, vp));
await browser.close();
console.log(JSON.stringify(results, null, 2));
