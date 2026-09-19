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
  for (const n of ['playwright', 'playwright-core']) { try { return require(n); } catch {} }
  const c = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  for (const d of (existsSync(c) ? readdirSync(c) : [])) { const p = path.join(c, d, 'node_modules', 'playwright'); if (existsSync(p)) return require(p); }
  throw new Error('Playwright not found');
}
const { chromium } = loadPlaywright();
const MIME = { '.html':'text/html', '.js':'application/javascript', '.mjs':'application/javascript', '.css':'text/css' };
const SUPABASE = `export function createClient(){const empty=async()=>({data:[],error:null});const b={select:()=>b,eq:()=>b,order:()=>b,limit:empty,maybeSingle:async()=>({data:null,error:null}),single:async()=>({data:null,error:null})};return {auth:{getSession:async()=>({data:{session:null},error:null}),getUser:async()=>({data:{user:null},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:()=>b,rpc:empty,channel:()=>({on:()=>({subscribe:()=>({})})}),removeChannel(){}}}export default {createClient};`;
const viewports = [{name:'desktop',width:1440,height:900},{name:'mobile',width:390,height:844}];
const browser = await chromium.launch();
const results=[];
for (const vp of viewports) {
  const ctx=await browser.newContext({viewport:{width:vp.width,height:vp.height}}); const page=await ctx.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*', route=>{const u=new URL(route.request().url()); if(u.hostname==='esm.sh') return route.fulfill({status:200,contentType:'application/javascript',body:SUPABASE}); if(u.origin===ORIGIN){const rel=decodeURIComponent(u.pathname).replace(/^\/+/, '')||'index.html';const f=path.resolve(ROOT,rel);if(f.startsWith(ROOT)&&existsSync(f))return route.fulfill({status:200,contentType:MIME[path.extname(f)]||'application/octet-stream',body:readFileSync(f)});return route.fulfill({status:404,body:''});}return route.fulfill({status:200,body:''});});
  await page.addInitScript(()=>{localStorage.setItem('shopStatus','open');localStorage.setItem('queues','[]');localStorage.setItem('appointments','[]');localStorage.setItem('activeSeats',JSON.stringify({1:true,2:true}));localStorage.setItem('barberAssignments',JSON.stringify({1:'Ali',2:'Bala'}));});
  await page.goto(`${ORIGIN}/index.html?view=barber`,{waitUntil:'load'}); await page.waitForTimeout(800);
  const observed=await page.evaluate(()=>{const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0};const boxes=[...document.querySelectorAll('#barber-app .panel-box')].map(e=>({id:e.id,text:e.innerText.slice(0,80),w:Math.round(e.getBoundingClientRect().width),h:Math.round(e.getBoundingClientRect().height)}));return {kanbanPanel:!!document.getElementById('kanbanPanel'),kanbanBoard:!!document.getElementById('kanbanBoard'),waitingPanel:visible(document.getElementById('barberWaitingPanel')),waitingText:document.getElementById('barberWaitingPanel')?.innerText||null,seatControls:document.getElementById('barberSeatControls')?.children.length||0,callButtons:[...document.querySelectorAll('#barberSeatControls button')].map(b=>({text:b.textContent.trim(),visible:visible(b),w:Math.round(b.getBoundingClientRect().width),h:Math.round(b.getBoundingClientRect().height)})),boxes};});
  results.push({viewport:vp,errors,observed}); await ctx.close();
}
await browser.close(); console.log(JSON.stringify(results,null,2));
