#!/usr/bin/env node
// Verify that a theme change made in the ADMIN view reflects on the CUSTOMER
// view within the same page/session (single-page app, views toggled by
// switchView -- no reload).
//
// Flow tested:
//  1. load customer view (default)
//  2. switch to admin view
//  3. change theme via the real picker path (changeTheme) to teal:dark
//  4. switch BACK to customer view
//  5. assert <html> still carries data-scheme=teal / data-theme=dark AND that
//     ACTUAL painted customer-surface colors use teal tokens (not gold)
//  6. reload the page and assert the customer view still comes up teal (persistence)
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

// teal/gold accents we expect to see painted on the customer surface
// (--primary-color #5ec8c0 -> rgb(94,200,192); gold #d8b06b) -- referenced in
// the assertions below via the painted nav accent, so no standalone constants.

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

  const out = { viewport: vp.name, pageErrors: errors, steps: [] };
  const probe = async (label) => {
    const r = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      // find a painted customer-surface accent: the active mode-toggle button
      const modeBtn = document.querySelector('.mode-toggle .mode-btn.active');
      const activeNav = document.querySelector('.app-nav .btn.active');
      return {
        activeView: document.querySelector('.view-section.active')?.id || null,
        dataScheme: document.documentElement.getAttribute('data-scheme'),
        dataTheme: document.documentElement.getAttribute('data-theme'),
        primary: cs.getPropertyValue('--primary-color').trim(),
        modeBtnBg: modeBtn ? getComputedStyle(modeBtn).backgroundColor : null,
        navActiveBg: activeNav ? getComputedStyle(activeNav).backgroundColor : null,
        customerHeaderColor: (() => { const h = document.getElementById('customerShopName'); return h ? getComputedStyle(h).color : null; })(),
        storedTheme: localStorage.getItem('appTheme'),
        storedScheme: localStorage.getItem('appScheme')
      };
    });
    r.label = label;
    out.steps.push(r);
    return r;
  };

  await probe('1. initial (customer)');
  // fake an admin session so the admin view actually opens (the nav is auth-gated)
  await page.evaluate(() => {
    window.onStaffAuthChange?.('SIGNED_IN',
      { user: { id: 'test-admin' } },
      { id: 'test-admin', displayName: 'Test Admin', role: 'admin', active: true });
  });
  await page.waitForTimeout(150);
  // switch to admin via the real nav handler
  await page.evaluate(() => { const b = document.querySelector('.app-nav .btn[data-view="admin-app"]'); if (b) b.click(); });
  await page.waitForTimeout(250);
  await probe('2. switched to admin');
  // change theme to teal:dark (real picker path)
  await page.evaluate(() => { window.changeTheme('teal:dark'); });
  await page.waitForTimeout(120);
  await probe('3. set teal:dark while on admin');
  // switch back to customer
  await page.evaluate(() => { const b = document.querySelector('.app-nav .btn[data-view="customer-app"]'); if (b) b.click(); });
  await page.waitForTimeout(200);
  const customerAfter = await probe('4. back on customer');

  // reload -> persistence across a fresh load
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(650);
  const afterReload = await probe('5. after reload (customer)');

  out.customerReflects = customerAfter.activeView === 'customer-app'
    && customerAfter.dataScheme === 'teal' && customerAfter.dataTheme === 'dark'
    && customerAfter.primary.toLowerCase() === '#5ec8c0'
    && customerAfter.navActiveBg.includes('47, 185, 173')   // teal accent painted on customer nav
    && customerAfter.customerHeaderColor === 'rgb(238, 247, 246)'; // teal text-main
  out.persistsAfterReload = afterReload.dataScheme === 'teal' && afterReload.dataTheme === 'dark'
    && afterReload.activeView === 'customer-app';
  out.goldNeverLeakedOnCustomer = customerAfter.navActiveBg !== 'rgba(191, 63, 11, 0.1)';
  out.enteredAdminView = out.steps[1].activeView === 'admin-app';

  await ctx.close();
  return out;
}

const browser = await chromium.launch();
const results = [];
for (const vp of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) results.push(await run(browser, vp));
await browser.close();
console.log(JSON.stringify(results, null, 2));
