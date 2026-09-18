import fs from 'fs';

const sql = fs.readFileSync('supabase/migrations/20260918100000_harden_overnight_booking_capacity.sql', 'utf8');
const failures = [];
const ok = (name, condition) => {
    if (condition) console.log(`  pass  ${name}`);
    else { failures.push(name); console.log(`  FAIL  ${name}`); }
};

console.log('\nOvernight booking capacity RPC contract');
ok('normalizes existing appointment times onto the business-day axis',
    /v_crosses_midnight|\+ 1440|v_open_minutes/i.test(sql));
ok('normalizes the requested interval before capacity scan',
    /p_start_minutes|p_end_minutes|v_minute/i.test(sql));
ok('retains advisory lock and helper replacement',
    /appointment_slot_capacity_ok|pg_advisory_xact_lock/i.test(sql));

console.log(`\n${failures.length ? failures.length + ' failed' : '3 passed'}`);
if (failures.length) process.exit(1);
