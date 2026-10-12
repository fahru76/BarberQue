import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
process.on('uncaughtException',e=>{console.error(e.message,e.detail,e.where);process.exit(1);});
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create schema realtime; create table realtime.messages(extension text);
create schema storage; create table storage.buckets(id text primary key,name text,public boolean);
create table storage.objects(id uuid,bucket_id text,name text);
create function realtime.topic() returns text language sql as $$ select ''::text $$;
create function realtime.send(jsonb,text,text,boolean) returns void language sql as $$ select $$;
create publication supabase_realtime;
grant usage on schema public,auth to anon,authenticated;
grant execute on function auth.uid() to anon,authenticated;`);
for (const file of fs.readdirSync('supabase/migrations').sort()) {
 let sql=fs.readFileSync('supabase/migrations/'+file,'utf8').replace('create extension if not exists pgcrypto;','');
 try { await db.exec(sql); } catch(e) { console.error('Migration failed:',file,e.message,e.position,sql.slice(Number(e.position)-100,Number(e.position)+100)); process.exit(1); }
}
console.log('All migrations replayed');
const admin='00000000-0000-0000-0000-000000000001', barber='00000000-0000-0000-0000-000000000002';
await db.exec(`set session_replication_role=replica; insert into auth.users values('${admin}'),('${barber}');
insert into public.staff(id,display_name,role,active) values('${admin}','Admin','admin',true),('${barber}','Ali','barber',true);
insert into public.shop_settings(id,weekly_op_hours,max_queue,seat_count) values(true,
(select jsonb_object_agg(i::text,jsonb_build_object('open','00:00','close','23:59','closed',false)) from generate_series(0,6) i),2,2);
insert into public.services(id,name,price_sen,duration_minutes,category,target,type) values
('BASIC','Gunting Biasa',2000,30,'asas','dewasa','gunting'),('KIDS','Kanak',1500,20,'asas','kanak','gunting'),
('FADE','Fade',3000,30,'fashion','dewasa','gunting'),('STYLE','Style',3000,30,'fashion','dewasa','gunting'),
('BALD','Botak',2000,30,'asas','semua','botak'),('COLOR','Warna',4000,30,'asas','semua','lain');
insert into public.seats(seat_no,active,barber_id,duty_date) values(1,true,'${barber}',public._current_business_date()); set session_replication_role=origin;`);
let passed=0;
const ok=async(name,fn)=>{await fn();console.log('PASS',name);passed++;};
const reject=async(sql)=>assert.rejects(db.exec(sql));
const anon=async(fn)=>{await db.exec('set role anon');try{return await fn();}finally{await db.exec('reset role');}};
const intake=`select public.take_walkin_ticket('Customer','0123456789',array['BASIC'],gen_random_uuid())`;
await ok('anon cannot directly insert or read history',()=>anon(async()=>{
 await reject('select name from public.queues'); await reject("insert into public.queues(id) values('fake')");
 await reject("select public.next_ticket_number('PG')");
}));
await db.exec("update public.shop_settings set shop_status='closed' where id=true");
await ok('closed intake rejected',()=>anon(()=>reject(intake)));
await db.exec("update public.shop_settings set shop_status='open' where id=true");
await ok('service combinations rejected',async()=>{
 for(const ids of ["'BASIC','FADE'","'FADE','STYLE'","'BASIC','KIDS'","'BALD','COLOR'","'BASIC','missing'"])
 await anon(()=>reject(`select public.take_walkin_ticket('Customer','',array[${ids}],gen_random_uuid())`));
});
await ok('input bounded and failed intake does not burn ticket numbers',async()=>{
 await anon(()=>reject(`select public.take_walkin_ticket('Customer',repeat('1',31),array['BASIC'],gen_random_uuid())`));
 assert.equal((await db.query('select count(*)::int n from public.ticket_counters')).rows[0].n,0);
});
await ok('server mints canonical service and price',()=>anon(async()=>{
 const row=(await db.query(intake)).rows[0].take_walkin_ticket;
 assert.equal(row.service,'Gunting Biasa'); assert.equal(row.price_sen,2000); assert.equal(row.claim_token,undefined);
 await db.exec(intake); await reject(intake);
}));
await ok('future capacity independent of current duty and stale today excluded',async()=>{
 await db.exec("update public.seats set duty_date=public._current_business_date()-1 where seat_no=1");
 assert.equal((await db.query("select public._appointment_slot_capacity_ok(public._current_business_date()+7,600,630,null) ok")).rows[0].ok,true);
 assert.equal((await db.query("select public._appointment_slot_capacity_ok(public._current_business_date(),600,630,null) ok")).rows[0].ok,false);
 await anon(()=>reject(intake));
});
await ok('past same-day booking rejected',async()=>{
 assert.equal((await db.query('select public._appointment_hours_ok(public._current_business_date(),0,30) ok')).rows[0].ok,false);
});
await ok('future booking canonical label and checkin limited to today',async()=>{
 const date=(await db.query("select (public._current_business_date()+7)::text d")).rows[0].d;
 const query=`select public.book_appointment('Booked','0123456789',gen_random_uuid(),'Forged label',30,1,'${date}','10:00',array['BASIC']) id`;
 const id=await anon(async()=> (await db.query(query)).rows[0].id);
 assert.equal((await db.query('select service from public.appointments where id=$1',[id])).rows[0].service,'Gunting Biasa');
 await db.exec(`select set_config('request.jwt.claim.sub','${admin}',false); set role authenticated;`);
 try{await reject(`select public.checkin_appointment('${id}')`);}finally{await db.exec('reset role');}
});
await ok('hidden self service API revoked',async()=>{
 await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${barber}',false)`);
 try{await reject("select public.set_my_services(array['FADE'],array['FADE'],null)");}finally{await db.exec('reset role');}
});
await ok('reports include deactivated barber and restrict own data',async()=>{
 await db.exec(`update public.queues set status='serving',seat_no=1,barber_id='${barber}',called_at=now() where id=(select id from public.queues order by id limit 1);
 update public.queues set status='done',completed_at=now() where status='serving';
 update public.staff set active=false where id='${barber}';
 select set_config('request.jwt.claim.sub','${admin}',false); set role authenticated;`);
 try { const rows=(await db.query('select * from public.barber_performance(current_date-1,current_date+1)')).rows;
 assert.equal(Number(rows[0].sales_sen),2000); }finally{await db.exec('reset role');}
 await db.exec(`update public.staff set active=true where id='${barber}'; select set_config('request.jwt.claim.sub','${barber}',false); set role authenticated;`);
 try {assert.equal((await db.query('select * from public.my_barber_performance(current_date-1,current_date+1)')).rows.length,1);
 await reject('select * from public.barber_performance(current_date-1,current_date+1)');}finally{await db.exec('reset role');}
});
await ok('dispatch ignores hidden capability and specialty',async()=>{
 await db.exec(`update public.seats set duty_date=public._current_business_date() where seat_no=1;
 update public.staff set capability_service_ids=array['FADE'],specialty_service_ids=array['FADE'] where id='${barber}';
 select set_config('request.jwt.claim.sub','${barber}',false); set role authenticated;`);
 try { const row=(await db.query('select * from public.call_next_customer(1)')).rows[0]; assert.equal(row.service,'Gunting Biasa'); }
 finally {await db.exec('reset role');}
});
await ok('specific call ignores capability and clears rest',async()=>{
 await db.exec(`update public.queues set status='done',completed_at=now() where status='serving';
 insert into public.queues(id,ticket_no,name,phone,claim_token,service,service_ids,duration_minutes,price_sen,source)
 values('SPECIFIC-TEST','SPECIFIC-TEST','Specific','',gen_random_uuid(),'placeholder',array['BASIC'],30,2000,'walkin');
 update public.seats set resting_since=now() where seat_no=1;
 select set_config('request.jwt.claim.sub','${barber}',false); set role authenticated;`);
 try {const row=(await db.query("select * from public.call_specific_customer(1,'SPECIFIC-TEST')")).rows[0]; assert.equal(row.id,'SPECIFIC-TEST');}
 finally {await db.exec('reset role');}
 assert.equal((await db.query('select resting_since from public.seats where seat_no=1')).rows[0].resting_since,null);
});
await ok('overnight report attributes after midnight to previous business day',async()=>{
 await db.exec(`update public.shop_settings set weekly_op_hours=(select jsonb_object_agg(i::text,jsonb_build_object('open','18:00','close','01:00','closed',false)) from generate_series(0,6) i) where id=true;`);
 assert.equal((await db.query("select public._report_business_date('2026-10-13 00:30:00+08')::text d")).rows[0].d,'2026-10-12');
 assert.equal((await db.query("select public._report_business_date('2026-10-13 01:30:00+08')::text d")).rows[0].d,'2026-10-13');
});
console.log(`${passed} audit scenarios passed`);
await db.close();
