// promote-barber
//
// Admin-only: turns an existing barber into an admin (Kakitangan ->
// "Jadikan Admin"). Barbers sign in with name + PIN and their Auth account
// has a synthetic e-mail and a random password nobody knows, so an admin
// account needs a real e-mail + password before it can use the Admin tab.
// This function:
//   1. checks the caller is an admin (is_admin() with the caller's JWT);
//   2. sets the barber's Auth e-mail + password (service_role);
//   3. switches the staff row to role 'admin' (caller's JWT, so the normal
//      staff policies/trigger apply);
//   4. deletes the barber's PIN, so an old PIN cannot come back to life if
//      the account is later turned back into a barber (the admin then sets
//      a new PIN).
// If step 3 fails, step 2 is undone (old e-mail restored).
//
// Going the other way (admin -> barber) needs no function: an admin changes
// the role in the staff list and then sets a PIN with admin_set_barber_pin().
//
// Deployed with verify_jwt = true; is_admin() below is the real gate.
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SYNTHETIC_EMAIL_DOMAIN = "@staff.c-cutzbarber.my";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: isAdmin, error: adminCheckError } = await callerClient.rpc("is_admin");
  if (adminCheckError) return json({ error: "Could not verify caller" }, 500);
  if (!isAdmin) return json({ error: "Not authorised" }, 403);

  let body: { staffId?: string; email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Permintaan tidak sah." }, 400);
  }
  const staffId = String(body.staffId ?? "");
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!UUID_RE.test(staffId)) return json({ error: "Kakitangan tidak sah." }, 400);
  if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "Masukkan e-mel yang sah." }, 400);
  if (email.endsWith(SYNTHETIC_EMAIL_DOMAIN)) return json({ error: "Gunakan e-mel sebenar tukang gunting ini." }, 400);
  if (password.length < 8 || password.length > 72) {
    return json({ error: "Kata laluan mesti 8 hingga 72 aksara." }, 400);
  }

  const { data: target, error: targetError } = await callerClient
    .from("staff").select("id, role").eq("id", staffId).maybeSingle();
  if (targetError) {
    console.error("[promote-barber] staff lookup failed:", targetError.message);
    return json({ error: "Gagal menyemak kakitangan." }, 502);
  }
  if (!target) return json({ error: "Kakitangan tidak ditemui." }, 404);
  if (target.role !== "barber") return json({ error: "Kakitangan ini sudah admin." }, 409);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const { data: before, error: getError } = await admin.auth.admin.getUserById(staffId);
  const oldEmail = before?.user?.email;
  if (getError || !oldEmail) {
    console.error("[promote-barber] getUserById failed:", getError?.message ?? "no email");
    return json({ error: "Akaun tidak ditemui." }, 502);
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(staffId, {
    email,
    password,
    email_confirm: true,
  });
  if (updateError) {
    const taken = /already|registered|exists/i.test(updateError.message);
    if (!taken) console.error("[promote-barber] updateUserById failed:", updateError.message);
    return json({ error: taken ? "E-mel ini sudah digunakan oleh akaun lain." : "Gagal menetapkan e-mel dan kata laluan." },
      taken ? 409 : 502);
  }

  const { error: roleError } = await callerClient
    .from("staff").update({ role: "admin", active: true }).eq("id", staffId);
  if (roleError) {
    console.error("[promote-barber] role update failed:", roleError.message);
    const { error: undoError } = await admin.auth.admin.updateUserById(staffId, { email: oldEmail, email_confirm: true });
    if (undoError) console.error("[promote-barber] rollback failed:", undoError.message);
    return json({ error: "Gagal menukar peranan. Tiada perubahan dibuat." }, 502);
  }

  // Best effort: the PIN is already unusable for an admin (PIN sign-in only
  // accepts role 'barber'); deleting it stops it working again after a
  // later demotion.
  const { error: pinError } = await admin.from("staff_pins").delete().eq("staff_id", staffId);
  if (pinError) console.error("[promote-barber] PIN cleanup failed:", pinError.message);

  return json({ id: staffId, email });
});
