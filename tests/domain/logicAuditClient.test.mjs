import fs from 'node:fs';
import assert from 'node:assert/strict';
const html=fs.readFileSync('index.html','utf8');
for(const match of html.matchAll(/^\s*<script([^>]*)>([\s\S]*?)<\/script>/gm)) {
 if(!match[1].includes('type="module"')) new Function(match[2]);
}
const extract=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
const queueCode=extract('        let liveQueuesMemory = null;', '        function getAppointments()');
const queues=new Function(`
 const safeSetItem=()=>false; const readJSON=()=>[]; const normalizeUTCFields=q=>q;
 ${queueCode}
 return {getQueues,saveQueues};`)();
const live=[{id:'new-live',status:'waiting'}];
assert.equal(queues.saveQueues(live),true);
assert.deepEqual(queues.getQueues(),live);
console.log('PASS fresh queue survives storage quota failure');
const merge=new Function(extract('        function mergeServerRows(', '        // A burst of writes')+';return mergeServerRows')();
const history=Array.from({length:20000},(_,i)=>({id:'old-'+i,status:'done',name:'Old customer'}));
assert.deepEqual(merge(history,live),live);
console.log('PASS 20000 historical rows pruned on refresh');
const seats=new Function('today','profiles',`
 const getCurrentBusinessDate=()=>today, getActiveSeats=()=>({'1':true,'2':true}), getSeatCount=()=>3;
 const seatProfiles=profiles;
 ${extract('        function getBookingSeats(', '        function isAppointmentSlotAvailable(')}
 return getBookingSeats;`)('2026-10-12',{'1':{onDuty:false},'2':{onDuty:true}});
assert.deepEqual(seats('2026-10-19'),{'1':true,'2':true,'3':true});
assert.deepEqual(seats('2026-10-12'),{'1':false,'2':true});
console.log('PASS planned future chairs and current duty today');
assert(!html.slice(html.indexOf('// Reports Rendering'),html.indexOf("window.addEventListener('storage'")).includes('filterCompletedQueuesForReportPeriod('));
assert(html.indexOf('const serverReports = new Map()') < html.lastIndexOf('</script>'));
console.log('PASS both rendered reports use server data');
const repo=fs.readFileSync('js/repositories/queueRepository.js','utf8');
const calls=[];
globalThis.auditSupabase={rpc:(name,params)=>{
 calls.push({name,params});
 if(name==='report_completed_tickets')return {range:async()=>({data:[],error:null})};
 return Promise.resolve({data:name==='take_walkin_ticket'?{id:'server-id',service:'Canonical',price_sen:2000}:[],error:null});
}};
const module=await import('data:text/javascript;base64,'+Buffer.from(repo.replace("import { supabase } from '../supabaseClient.js';",'const supabase=globalThis.auditSupabase;')).toString('base64'));
const ticket=await module.takeTicket({name:'A',phone:'012',serviceIds:['BASIC'],service:'Forged',prefix:'FAKE'});
assert.equal(ticket.id,'server-id');assert(ticket.claimToken);
assert.deepEqual(Object.keys(calls[0].params).sort(),['p_claim_token','p_name','p_phone','p_service_ids']);
assert.equal(calls[0].name,'take_walkin_ticket');
await module.loadSalesReport('2026-10-01','2026-10-12',true);
assert.deepEqual(calls.slice(1).map(c=>c.name),['my_barber_performance','report_completed_tickets']);
delete globalThis.auditSupabase;
console.log('PASS atomic intake repository and scoped report calls');
let pages=0;
globalThis.auditSupabase={rpc:(name,params)=>{
 if(name!=='report_completed_tickets')return Promise.resolve({data:[],error:null});
 return {range:async(from,to)=>{assert.equal(to-from,999);pages++;return {data:Array.from({length:from===0?1000:1},(_,i)=>({id:String(from+i),price_sen:2000})),error:null};}};
}};
// Import again so the repository closes over the pagination mock.
const paginated=await import('data:text/javascript;base64,'+Buffer.from(repo.replace("import { supabase } from '../supabaseClient.js';",'const supabase=globalThis.auditSupabase;')+'\n// pagination mock').toString('base64'));
const full=await paginated.loadSalesReport('2026-10-01','2026-10-31');
assert.equal(full.records.length,1001);assert.equal(pages,2);delete globalThis.auditSupabase;
console.log('PASS report details exceed the 1000-row API cap');
