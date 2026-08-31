// invite-barber
//
// Admin-only: invites a new barber by email using the Supabase Auth Admin
// API (auth.admin.inviteUserByEmail), which requires the service_role key.
// That key is read here from this function's own environment
// (SUPABASE_SERVICE_ROLE_KEY, provided automatically by the platform) and
// never touches the browser — this function is the only place in the
// codebase that key exists.
//
// Deployed with verify_jwt = true, so the platform already rejects any
// request without a valid JWT before this code even runs. That only proves
// "some signed-in user called this" — it says nothing about whether they are
// an admin. The is_admin() check below, run with the CALLER's own JWT (not
// this function's), is what actually gates the invite. Do not remove it on
// the assumption verify_jwt already covers it.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  // Browsers preflight a cross-origin POST with a JSON body via an OPTIONS
  // request that never carries the caller's Authorization value — this must
  // be answered before any auth check, or supabase-js's functions.invoke()
  // never gets to send the real POST at all.
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Scoped to the caller's own JWT (forwarded, not this function's), so
  // is_admin() evaluates auth.uid() as the actual caller.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: isAdmin, error: adminCheckError } = await callerClient.rpc("is_admin");
  if (adminCheckError) return json({ error: "Could not verify caller" }, 500);
  if (!isAdmin) return json({ error: "Not authorised" }, 403);

  let body: { email?: string; displayName?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const email = String(body.email ?? "").trim();
  const displayName = String(body.displayName ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Invalid email" }, 400);
  if (displayName.length < 1 || displayName.length > 60) {
    return json({ error: "Display name must be 1-60 characters" }, 400);
  }

  // service_role bypasses RLS and can only be used server-side — this is the
  // one and only place this codebase reads that key.
  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  // `data` here becomes raw_user_meta_data on the new auth.users row, which
  // handle_new_staff_user (supabase/migrations/20260901000000_init_core.sql)
  // reads as display_name when it auto-creates the (inactive, 'barber')
  // staff row on insert. Nothing else needs to run here — an admin still
  // flips `active = true` from the staff list once the invite is accepted,
  // per the design decision that new sign-ups start inactive.
  const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
    data: { display_name: displayName },
  });
  if (error) {
    const status = typeof error.status === "number" && error.status < 500 ? error.status : 502;
    return json({ error: error.message }, status);
  }

  return json({ id: data.user?.id, email: data.user?.email });
});
