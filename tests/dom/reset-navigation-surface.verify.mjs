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
const SUPABASE = `export function createClient(){const empty=async()=>({data:[],error:null});const b={select:()=>b,eq:()=>b,order:()=>b,limit:empty,maybeSingle:async()=>({data:null,error:null}),single:async()=>({data:null,error:null})};return {auth:{getSession:async()=>({data:{session:{user:{id:'admin-1'}}},error:null}),getUser:async()=>({data:{user:{id:'admin-1'}} ,error:null}),onAuthStateChange:(cb)=>{setTimeout(()=>cb('SIGNED_IN',{user:{id:'admin-1'}}),0);return {data:{subscription:{unsubscribe(){}}}}}},from:()=>b,rpc:async()=>({data:null,error:null}),channel:()=>({on:()=>({subscribe:()=>({})})}),removeChannel(){}}}export default {createClient};`;
const viewports = [{name:'desktop',width:1440,height:900},{name:'mobile',width:390,height:844}];
const browser = await chromium.launch();
const results=[];
for (const vp of viewports) {
  const ctx=await browser.newContext({viewport:{width:vp.width,height:vp.height}}); const page=await ctx.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*', route=>{const u=new URL(route.request().url()); if(u.hostname==='esm.sh') return route.fulfill({status:200,contentType:'application/javascript',body:SUPABASE}); if(u.origin===ORIGIN){const rel=decodeURIComponent(u.pathname).replace(/^\/+/, '')||'index.html';const f=path.resolve(ROOT,rel);if(f.startsWith(ROOT)&&existsSync(f))return route.fulfill({status:200,contentType:MIME[path.extname(f)]||'application/octet-stream',body:readFileSync(f)});return route.fulfill({status:404,body:''});}return route.fulfill({status:200,body:''});});
  await page.addInitScript(()=>{localStorage.setItem('shopStatus','open');localStorage.setItem('queues','[]');localStorage.setItem('appointments','[]');history.replaceState(null,'','?view=customer');});
  await page.goto(`${ORIGIN}/index.html?view=customer`,{waitUntil:'load'}); await page.waitForTimeout(900);
  await page.waitForTimeout(1200);
  await page.evaluate(() => { window.onStaffAuthChange?.('SIGNED_IN', { user: { id: 'admin-1' } }, { id: 'admin-1', role: 'admin', active: true, displayName: 'Admin' }); });
  await page.evaluate(() => { const b = document.querySelector('.app-nav .btn[data-view="admin-app"]'); if (b) b.click(); });
  await page.waitForTimeout(250);
  const observed=await page.evaluate(()=>{const box=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),right:Math.round(r.right),bottom:Math.round(r.bottom)}};const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0};return {activeView:document.querySelector('.view-section.active')?.id||null,resetVisible:visible(document.getElementById('appResetBtn')),resetText:document.getElementById('appResetBtn')?.textContent.trim()||null,adminGlobalPresent:!!document.getElementById('adminGlobalResetBtn'),navBox:box(document.getElementById('appResetBtn'))};});
  await page.evaluate(()=>document.getElementById('appResetBtn')?.click()); await page.waitForTimeout(150);
  const dialog=await page.evaluate(()=>{const d=document.getElementById('operationalResetDialog'),i=document.getElementById('operationalResetConfirmation'),b=document.getElementById('operationalResetConfirmBtn'),m=document.getElementById('operationalResetDialogMessage');const r=d?.getBoundingClientRect();return {open:!!(d?.open||d?.hasAttribute('open')),scope:d?.dataset.scope||null,inputFocused:document.activeElement===i,confirmDisabled:!!b?.disabled,label:i?.previousElementSibling?.textContent?.trim()||null,message:m?.textContent?.trim()||null,box:r?{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),right:Math.round(r.right),bottom:Math.round(r.bottom)}:null,overflow:d?d.scrollWidth>d.clientWidth+1||d.scrollHeight>d.clientHeight+1:null};});
  await page.locator('#operationalResetConfirmation').fill('RESET');
  const enabled=await page.evaluate(()=>({disabled:document.getElementById('operationalResetConfirmBtn')?.disabled??null,dialogOpen:document.getElementById('operationalResetDialog')?.open??false}));
  results.push({viewport:vp,errors,observed,dialog,afterExactInput:enabled}); await ctx.close();
}
await browser.close(); console.log(JSON.stringify(results,null,2));
