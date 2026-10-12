// admin-recover
//
// Lock-out recovery for admins (migration 20261012170000). With the admin's
// e-mail, the one-time recovery key (generated in Admin > Kakitangan and kept
// offline) and a new password, this:
//   1. checks key + e-mail with _check_admin_recovery() -- 5 wrong attempts
//      lock recovery for 1 hour; a wrong key and a non-admin e-mail get the
//      same answer so the endpoint does not reveal which e-mails are admins;
//   2. sets the new password (Auth Admin API, service_role);
//   3. only then reactivates the admin and spends the key
//      (_finish_admin_recovery), so a failed password update never burns it.
//
// Deployed with verify_jwt = false: the caller is locked out, so has no JWT.
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { email?: string; key?: string; newPassword?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Permintaan tidak sah." }, 400);
  }
  const email = String(body.email ?? "").trim();
  const key = String(body.key ?? "");
  const newPassword = String(body.newPassword ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || key.replace(/[^A-Za-z0-9]/g, "").length !== 20) {
    return json({ error: "Kunci pemulihan atau e-mel tidak sah." }, 400);
  }
  if (newPassword.length < 8 || newPassword.length > 72) {
    return json({ error: "Kata laluan baharu mesti 8 hingga 72 aksara." }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: adminId, error: checkError } = await admin.rpc("_check_admin_recovery", {
    p_key: key,
    p_email: email,
  });
  if (checkError) {
    // The only raised error is the 1-hour lock (its message is safe to show).
    const locked = checkError.code === "42501";
    if (!locked) console.error("[admin-recover] _check_admin_recovery failed:", checkError.message);
    return json(
      { error: locked ? "Terlalu banyak cubaan. Cuba lagi selepas 1 jam." : "Pemulihan gagal. Sila cuba lagi." },
      locked ? 429 : 502,
    );
  }
  if (!adminId) {
    return json({ error: "Kunci pemulihan atau e-mel tidak sah." }, 401);
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(adminId, { password: newPassword });
  if (updateError) {
    console.error("[admin-recover] updateUserById failed:", updateError.message);
    return json({ error: "Kata laluan baharu tidak dapat ditetapkan. Kunci anda belum digunakan; cuba lagi." }, 502);
  }

  const { error: finishError } = await admin.rpc("_finish_admin_recovery", { p_admin_id: adminId });
  if (finishError) {
    // Password is already changed; report success but log the leftover.
    console.error("[admin-recover] _finish_admin_recovery failed:", finishError.message);
  }

  return json({ ok: true });
});
