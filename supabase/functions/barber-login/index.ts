// barber-login
//
// PIN sign-in for barbers (migration 20261012170000). Barbers have no e-mail
// invite and no known password: an admin creates them with a name + 6-digit
// PIN (create-barber). This function:
//   1. checks the PIN with _verify_barber_pin() -- counts wrong attempts and
//      locks that barber for 15 minutes after 5;
//   2. on success rotates the account's hidden password to a fresh random
//      one and signs in with it server-side;
//   3. returns that session's tokens; the browser adopts them with
//      supabase.auth.setSession().
// The PIN is therefore never usable against Supabase's own sign-in endpoint,
// so its small key space is protected by the lockout above.
//
// Deployed with verify_jwt = false: the caller is not signed in yet (that is
// the point), and the shop's publishable key is not a JWT.
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

function randomPassword(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[^A-Za-z0-9]/g, "").slice(0, 60);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { staffId?: string; pin?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Permintaan tidak sah." }, 400);
  }
  const staffId = String(body.staffId ?? "");
  const pin = String(body.pin ?? "");
  if (!UUID_RE.test(staffId) || !/^[0-9]{6}$/.test(pin)) {
    return json({ error: "Pilih nama anda dan masukkan PIN 6 digit." }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: verdict, error: verifyError } = await admin.rpc("_verify_barber_pin", {
    p_staff_id: staffId,
    p_pin: pin,
  });
  if (verifyError) {
    console.error("[barber-login] _verify_barber_pin failed:", verifyError.message);
    return json({ error: "Log masuk gagal. Sila cuba lagi." }, 502);
  }
  if (verdict === "locked") {
    return json({ error: "Terlalu banyak PIN salah. Cuba lagi selepas 15 minit." }, 429);
  }
  if (verdict !== "ok") {
    return json({ error: "Nama atau PIN tidak sah." }, 401);
  }

  const { data: userData, error: userError } = await admin.auth.admin.getUserById(staffId);
  const email = userData?.user?.email;
  if (userError || !email) {
    console.error("[barber-login] getUserById failed:", userError?.message ?? "no email");
    return json({ error: "Log masuk gagal. Sila cuba lagi." }, 502);
  }

  const password = randomPassword();
  const { error: updateError } = await admin.auth.admin.updateUserById(staffId, { password });
  if (updateError) {
    console.error("[barber-login] updateUserById failed:", updateError.message);
    return json({ error: "Log masuk gagal. Sila cuba lagi." }, 502);
  }

  const signer = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { data: signIn, error: signInError } = await signer.auth.signInWithPassword({ email, password });
  if (signInError || !signIn.session) {
    console.error("[barber-login] signInWithPassword failed:", signInError?.message ?? "no session");
    return json({ error: "Log masuk gagal. Sila cuba lagi." }, 502);
  }

  return json({
    access_token: signIn.session.access_token,
    refresh_token: signIn.session.refresh_token,
  });
});
