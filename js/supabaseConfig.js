/**
 * Supabase connection details.
 *
 * These are safe to commit and safe to ship in the browser: the publishable key
 * only ever acts as the `anon` role, and what that role may do is decided by the
 * RLS policies and column grants in supabase/migrations, not by keeping this
 * string secret.
 *
 * The service_role key is the opposite — it bypasses RLS entirely. Never put it
 * in this file or anywhere else in the front end.
 */
export const SUPABASE_URL = 'https://cojaebzxrtyvxrnadiuv.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_t5jWXLzmoTSI1lTPqVWOgg_dvNXmui1';
