/**
 * Static privilege check for the migrations.
 *
 * This is NOT a Postgres parse -- no server is available here. It catches the
 * one defect class this project has actually shipped three separate times
 * (see HANDOFF.md: 20260901000300, 20260901000800,
 * 20260909141439): a new `security definer` function that never gets an
 * explicit `revoke ... from anon`.
 *
 * Why that specific statement is required: Supabase applies DEFAULT
 * PRIVILEGES granting EXECUTE on new public functions to `anon` and
 * `authenticated` by name. `revoke ... from public` does NOT remove those
 * per-role grants -- `public` is a different grantee. So a function that
 * looks locked down can still be callable by anyone holding the (publicly
 * shipped) anon key, relying on its own internal auth check alone. That
 * happened to barber_performance(), checkin_appointment()/approve_fast_pass()/
 * revoke_fast_pass(), and admin_remove_staff().
 *
 * A function is considered safe here if EITHER:
 *   - it has an explicit `revoke ... from anon` (defence in depth), OR
 *   - it is on INTENTIONALLY_ANON_CALLABLE below, i.e. its whole purpose is
 *     to serve signed-out customers and it is designed to be public.
 *
 * It also asserts every `security definer` function pins `search_path`,
 * which sql-consistency.mjs already checks -- repeated here because both
 * properties are about the same thing (the function's own security posture)
 * and a function failing one while passing the other is exactly the
 * combination worth refusing.
 */
import fs from 'fs';
import path from 'path';

const dir = 'supabase/migrations';
const files = fs.readdirSync(dir).sort();
const sql = files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
const clean = sql.replace(/--[^\n]*/g, '');

/**
 * Functions whose entire purpose is to serve signed-out customers, so anon
 * EXECUTE is intended, not an oversight. Every entry here must be a real
 * customer-facing entry point; adding to this list is a security decision,
 * not a convenience.
 */
const INTENTIONALLY_ANON_CALLABLE = new Set([
    'next_ticket_number',                 // customers have no account
    'cancel_own_ticket',                  // claim-token verified inside
    'book_appointment',                   // public booking form
    'cancel_own_appointment',             // claim-token verified inside
    'reschedule_own_appointment',         // claim-token verified inside
    'convert_walkin_to_appointment',      // claim-token verified inside
    'list_today_queues'                   // anon-safe column subset only
]);

// ---- function definitions (last definition of a name wins) ---------------
const defs = new Map();
for (const m of clean.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([\w_]+)\s*\(([\s\S]*?)\bas\s*\$\$/gi)) {
    defs.set(m[1], {
        name: m[1],
        securityDefiner: /security\s+definer/i.test(m[2]),
        returnsTrigger: /returns\s+trigger/i.test(m[2]),
        pinsSearchPath: /set\s+search_path\s*=/i.test(m[2])
    });
}

// ---- explicit revoke/grant statements ------------------------------------
const revokedFromAnon = new Set();
const grantedToAnon = new Set();
for (const m of clean.matchAll(/revoke\s+[\s\S]{0,80}?on\s+function\s+public\.([\w_]+)\s*\([^)]*\)\s*from\s+([^;]+);/gi)) {
    if (/\banon\b/.test(m[2].toLowerCase())) revokedFromAnon.add(m[1]);
}
for (const m of clean.matchAll(/grant\s+execute\s+on\s+function\s+public\.([\w_]+)\s*\([^)]*\)\s+to\s+([^;]+);/gi)) {
    if (/\banon\b/.test(m[2].toLowerCase())) grantedToAnon.add(m[1]);
}

const problems = [];

// ---- 1. definer functions reachable by anon without an explicit revoke ----
for (const def of defs.values()) {
    if (!def.securityDefiner || def.returnsTrigger) continue;
    if (revokedFromAnon.has(def.name)) continue;
    if (INTENTIONALLY_ANON_CALLABLE.has(def.name)) continue;
    problems.push(
        `${def.name}() is security definer but never explicitly revoked from anon ` +
        `(Supabase DEFAULT PRIVILEGES grant EXECUTE to anon by name; ` +
        `"revoke ... from public" does not remove it)`
    );
}

// ---- 2. search_path pin ---------------------------------------------------
for (const def of defs.values()) {
    if (def.securityDefiner && !def.pinsSearchPath) {
        problems.push(`${def.name}() is security definer but does not pin search_path`);
    }
}

// ---- 3. the anon-callable allowlist must stay honest ---------------------
// If a name here no longer exists in the migrations, the allowlist is stale
// and could be masking a real finding by accident.
for (const name of INTENTIONALLY_ANON_CALLABLE) {
    if (!defs.has(name)) problems.push(`allowlisted anon-callable function ${name}() no longer exists`);
}

// ---- 4. anon-callable implies an explicit grant --------------------------
// A name on the allowlist that nothing ever grants EXECUTE to anon is a sign
// the list drifted from reality.
for (const name of INTENTIONALLY_ANON_CALLABLE) {
    if (defs.has(name) && !grantedToAnon.has(name)) {
        problems.push(`allowlisted anon-callable function ${name}() has no explicit "grant execute ... to anon"`);
    }
}

// ---- report ---------------------------------------------------------------
const definerFns = [...defs.values()].filter(d => d.securityDefiner && !d.returnsTrigger);
console.log('migrations:', files.length);
console.log(`security definer (non-trigger) functions: ${definerFns.length}`);
console.log(`  explicitly revoked from anon : ${definerFns.filter(d => revokedFromAnon.has(d.name)).length}`);
console.log(`  intentionally anon-callable  : ${definerFns.filter(d => INTENTIONALLY_ANON_CALLABLE.has(d.name)).length}`);
console.log(`  search_path pinned           : ${definerFns.filter(d => d.pinsSearchPath).length}/${definerFns.length}`);
console.log(`\n${problems.length ? 'PROBLEMS:\n  ' + problems.join('\n  ') : 'no privilege inconsistencies found'}`);
process.exit(problems.length ? 1 : 0);