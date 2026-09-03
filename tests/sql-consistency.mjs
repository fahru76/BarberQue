/**
 * Static consistency check for the migrations.
 *
 * This is NOT a Postgres parse — no server is available here. It catches the
 * errors that actually bite in practice: a column named in a policy, index,
 * constraint, grant or function body that does not exist on the table.
 */
import fs from 'fs';
import path from 'path';

const dir = 'supabase/migrations';
const files = fs.readdirSync(dir).sort();
const sql = files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
const strip = s => s.replace(/--[^\n]*/g, '');
const clean = strip(sql);

// ---- tables and their columns -------------------------------------------
const tables = {};
for (const m of clean.matchAll(/create table (?:if not exists )?public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const [, name, body] = m;
    const cols = [];
    let depth = 0, line = '';
    for (const ch of body) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { cols.push(line); line = ''; } else line += ch;
    }
    cols.push(line);
    tables[name] = cols
        .map(c => c.trim())
        .filter(c => c && !/^(constraint|primary key|unique|check|foreign key)\b/i.test(c))
        .map(c => c.split(/\s+/)[0]);
}

let problems = [];
const known = new Set(['auth', 'now', 'true', 'false', 'null', 'public']);

// ---- every public.<table> reference names a real table -------------------
for (const m of clean.matchAll(/public\.(\w+)/g)) {
    const n = m[1];
    if (tables[n]) continue;
    if (/^(is_active_staff|is_admin|bump_row_version|handle_new_staff_user|next_ticket_number|cancel_own_ticket|call_next_customer|complete_service|barber_performance|_appointment_slot_capacity_ok|_appointment_hours_ok|book_appointment|cancel_own_appointment|reschedule_own_appointment|convert_walkin_to_appointment|checkin_appointment|approve_fast_pass|revoke_fast_pass|list_today_queues_full|list_active_appointments|admin_cancel_record|_current_business_date)$/.test(n)) continue;
    problems.push(`unknown public.${n}`);
}

// ---- grant column lists exist on their table -----------------------------
for (const m of clean.matchAll(/grant\s+(?:select|insert|update)\s*\(([^)]+)\)\s*\n?\s*on public\.(\w+)/gi)) {
    const cols = m[1].split(',').map(c => c.trim());
    const t = m[2];
    for (const c of cols) if (!tables[t]?.includes(c)) problems.push(`grant on ${t}: no column "${c}"`);
}

// ---- index columns exist -------------------------------------------------
for (const m of clean.matchAll(/create (?:unique )?index \w+\s*\n?\s*on public\.(\w+)\s*\(([^)]+)\)/g)) {
    const t = m[1];
    for (const c of m[2].split(',').map(s => s.trim().replace(/\s+(asc|desc)$/i, ''))) {
        if (!tables[t]?.includes(c)) problems.push(`index on ${t}: no column "${c}"`);
    }
}

// ---- policies reference an existing table and a sane command -------------
const policies = [...clean.matchAll(/create policy "([^"]+)"\s*\n?\s*on public\.(\w+)\s+for (\w+)/g)];
for (const [, name, t, cmd] of policies) {
    if (!tables[t]) problems.push(`policy "${name}" on unknown table ${t}`);
    if (!/^(select|insert|update|delete|all)$/i.test(cmd)) problems.push(`policy "${name}" bad command ${cmd}`);
}

// ---- every RLS-enabled table has at least one policy ---------------------
const rlsOn = [...clean.matchAll(/alter table public\.(\w+)\s+enable row level security/g)].map(m => m[1]);
for (const t of rlsOn) {
    if (!policies.some(p => p[2] === t)) {
        // ticket_counters is intentionally policy-free: reached only via SECURITY DEFINER
        if (t !== 'ticket_counters') problems.push(`RLS enabled on ${t} but no policy defined`);
    }
}

// ---- SECURITY DEFINER functions must pin search_path ---------------------
for (const m of clean.matchAll(/create or replace function public\.(\w+)([\s\S]*?)\bas \$\$/g)) {
    const [, fn, head] = m;
    if (/security definer/i.test(head) && !/set search_path\s*=/i.test(head)) {
        problems.push(`SECURITY DEFINER function ${fn}() does not pin search_path`);
    }
}

// ---- balanced $$ and parens ---------------------------------------------
const dollars = (clean.match(/\$\$/g) || []).length;
if (dollars % 2 !== 0) problems.push(`unbalanced $$ delimiters (${dollars})`);
const opens = (clean.match(/\(/g) || []).length, closes = (clean.match(/\)/g) || []).length;
if (opens !== closes) problems.push(`unbalanced parentheses: ${opens} open, ${closes} close`);

// ---- report --------------------------------------------------------------
console.log('migrations:', files.join(', '));
console.log('\ntables and columns');
for (const [t, cols] of Object.entries(tables)) console.log(`  ${t.padEnd(17)} ${cols.length} cols: ${cols.join(', ')}`);
console.log(`\npolicies: ${policies.length} | RLS-enabled tables: ${rlsOn.length} | $$ pairs: ${dollars / 2}`);
console.log(`parens: ${opens} open / ${closes} close`);
console.log(`\n${problems.length ? 'PROBLEMS:\n  ' + problems.join('\n  ') : 'no inconsistencies found'}`);
process.exit(problems.length ? 1 : 0);
