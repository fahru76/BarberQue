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
const SUPABASE = `export function createClient(){const empty=async()=>({data:[],error:null});const b={select:()=>b,eq:()=>b,order:()=>b,limit:empty,maybeSingle:async()=>({data:null,error:null}),single:async()=>({data:null,error:null})};return {auth:{getSession:async()=>({data:{session:null},error:null}),getUser:async()=>({data:{user:null},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:()=>b,rpc:async(name)=>name==='list_today_queues'?({data:[],error:null}):empty(),channel:()=>({on:()=>({subscribe:()=>({})})}),removeChannel(){}}}export default {createClient};`;
const viewports = [{name:'desktop',width:1440,height:900},{name:'mobile',width:390,height:844}];
const browser = await chromium.launch();
const results=[];
for (const vp of viewports) {
  const ctx=await browser.newContext({viewport:{width:vp.width,height:vp.height}}); const page=await ctx.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*', route=>{const u=new URL(route.request().url()); if(u.hostname==='esm.sh') return route.fulfill({status:200,contentType:'application/javascript',body:SUPABASE}); if(u.origin===ORIGIN){const rel=decodeURIComponent(u.pathname).replace(/^\/+/, '')||'index.html';const f=path.resolve(ROOT,rel);if(f.startsWith(ROOT)&&existsSync(f))return route.fulfill({status:200,contentType:MIME[path.extname(f)]||'application/octet-stream',body:readFileSync(f)});return route.fulfill({status:404,body:''});}return route.fulfill({status:200,body:''});});
  await page.addInitScript(()=>{localStorage.setItem('shopStatus','open');localStorage.setItem('queues',JSON.stringify([{id:'LIVECHECK-20260919',name:'__livecheck__',status:'serving',seat:1,service:'Gunting Biasa'}]));localStorage.setItem('appointments','[]');localStorage.setItem('activeSeats',JSON.stringify({1:true}));localStorage.setItem('barberAssignments',JSON.stringify({1:'Fahru'}));history.replaceState(null,'','?view=customer');});
  await page.goto(`${ORIGIN}/index.html?view=customer`,{waitUntil:'load'}); await page.waitForTimeout(1200);
  const observed=await page.evaluate(()=>{const text=document.body.innerText;const queue=JSON.parse(localStorage.getItem('queues')||'[]');const seat=el=>{if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),overflow:el.scrollWidth>el.clientWidth+1||el.scrollHeight>el.clientHeight+1,text:el.innerText.trim()};};return {staleInStorage:queue.some(q=>q.id==='LIVECHECK-20260919'),staleInRenderedText:text.includes('LIVECHECK')||text.includes('__livecheck__'),customerSurface:seat(document.getElementById('customer-app')),tvSurface:seat(document.getElementById('display-app')),bodyOverflow:document.documentElement.scrollWidth>window.innerWidth+1};});
  results.push({viewport:vp,errors,observed}); await ctx.close();
}
await browser.close(); console.log(JSON.stringify(results,null,2));
