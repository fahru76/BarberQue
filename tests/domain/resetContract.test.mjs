import fs from 'fs';

const html = fs.readFileSync('index.html', 'utf8');
const sql = fs.readFileSync('supabase/migrations/20260919181000_harden_operational_reset_delete_safeupdate.sql', 'utf8');
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
const resetUpdates = [...sql.matchAll(/update\s+public\.(shop_settings|staff)\s+set\b[^;]*;/gi)].map(match => match[0]);
ok('reset destructive statements use explicit safe-update predicates',
    !/delete\s+from\s+public\.services\s*;/i.test(sql) &&
    resetUpdates.length > 0 && resetUpdates.every(statement => /\bwhere\b/i.test(statement)));
ok('section reset scopes are exposed', ['shop','announcement','closedDates','services','hours','seats'].every(scope => html.includes(`openOperationalResetDialog('${scope}')`)));
ok('server commit is separated from local hydration failure', /The RPC is the commit point/.test(html) && /Reset berjaya di server/.test(html));

console.log(`\n${failures.length ? failures.length + ' failed' : '5 passed'}`);
if (failures.length) process.exit(1);
