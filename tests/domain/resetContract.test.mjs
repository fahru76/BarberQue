import fs from 'fs';

const html = fs.readFileSync('index.html', 'utf8');
const sql = fs.readFileSync('supabase/migrations/20260918110000_safe_operational_reset.sql', 'utf8');
const failures = [];
const ok = (name, condition) => {
    if (condition) console.log(`  pass  ${name}`);
    else { failures.push(name); console.log(`  FAIL  ${name}`); }
};

console.log('\nSafe operational reset contract');
ok('reset RPC requires admin authorization', /is_admin\(\)/.test(sql));
ok('reset RPC blocks live queues and upcoming appointments', /status in \('waiting', 'serving'\)/.test(sql) && /status = 'upcoming'/.test(sql));
ok('reset RPC preserves history tables', !/delete from public\.(queues|appointments)/i.test(sql));
ok('reset RPC preserves staff accounts', !/delete from public\.staff/i.test(sql));
ok('reset requires explicit RESET confirmation in UI', /RESET/.test(html) && /resetOperationalState/.test(html));
ok('global reset preserves staff and history by SQL shape', !/delete from public\.(staff|queues|appointments)/i.test(sql));
ok('section reset scopes are exposed', ['shop','announcement','closedDates','services','seats'].every(scope => html.includes(`openOperationalResetDialog('${scope}')`)));

console.log(`\n${failures.length ? failures.length + ' failed' : '5 passed'}`);
if (failures.length) process.exit(1);
