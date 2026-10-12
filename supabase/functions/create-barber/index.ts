// create-barber
//
// Admin-only: creates a barber from a name + 6-digit PIN (migration
// 20261012170000). Replaces invite-barber -- no e-mail is sent.
//
// The Auth account gets a synthetic, never-mailed address and a random
// password nobody knows; the barber signs in with name + PIN through
// barber-login. handle_new_staff_user creates the staff row (inactive
// barber, display_name from user_metadata); this function then activates it
// and sets the PIN using the CALLER's own JWT, so both writes go through the
// normal admin checks (is_admin(), admin_set_barber_pin()).
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

function randomPassword(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[^A-Za-z0-9]/g, "").slice(0, 60);
}

// Never mailed (email_confirm: true, no invite). Uses the shop's own domain
// so the address can never belong to someone else.
const SYNTHETIC_EMAIL_DOMAIN = "staff.c-cutzbarber.my";

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

  let body: { displayName?: string; pin?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Permintaan tidak sah." }, 400);
  }
  const displayName = String(body.displayName ?? "").replace(/\s+/g, " ").trim();
  const pin = String(body.pin ?? "");
  if (displayName.length < 1 || displayName.length > 60) {
    return json({ error: "Nama mesti 1 hingga 60 aksara." }, 400);
  }
  if (!/^[0-9]{6}$/.test(pin)) {
    return json({ error: "PIN mesti 6 digit nombor." }, 400);
  }

  // Friendly duplicate check (staff_name_key_uidx is the real guard).
  const nameKey = displayName.toLowerCase();
  const { data: clash } = await callerClient.from("staff").select("id").eq("name_key", nameKey).limit(1);
  if (clash && clash.length) return json({ error: "Nama ini telah digunakan oleh kakitangan lain." }, 409);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: `barber-${crypto.randomUUID()}@${SYNTHETIC_EMAIL_DOMAIN}`,
    password: randomPassword(),
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });
  const userId = created?.user?.id;
  if (createError || !userId) {
    console.error("[create-barber] createUser failed:", createError?.message ?? "no user");
    return json({ error: "Akaun tukang gunting gagal dicipta." }, 502);
  }

  // Roll the account back if either follow-up step fails, so a half-made
  // barber (no PIN, or inactive) never lingers in the staff list.
  const rollBack = async (message: string, status: number) => {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) console.error("[create-barber] rollback deleteUser failed:", error.message);
    return json({ error: message }, status);
  };

  const { error: pinError } = await callerClient.rpc("admin_set_barber_pin", { p_staff_id: userId, p_pin: pin });
  if (pinError) {
    // Malay validation messages from the RPC (e.g. "PIN terlalu mudah diteka")
    // are meant for the admin; anything else stays generic.
    const userMessage = pinError.code === "22023" ? pinError.message : "PIN gagal ditetapkan.";
    if (pinError.code !== "22023") console.error("[create-barber] admin_set_barber_pin failed:", pinError.message);
    return rollBack(userMessage, pinError.code === "22023" ? 400 : 502);
  }

  const { error: activateError } = await callerClient
    .from("staff")
    .update({ active: true, display_name: displayName })
    .eq("id", userId);
  if (activateError) {
    console.error("[create-barber] activate failed:", activateError.message);
    return rollBack("Akaun tukang gunting gagal diaktifkan.", 502);
  }

  return json({ id: userId, displayName });
});
