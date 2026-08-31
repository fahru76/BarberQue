/**
 * Shared Supabase client for the browser.
 *
 * index.html has no bundler and no build step (it is served as-is from GitHub
 * Pages), so the client library is loaded from a CDN as a plain ES module
 * rather than from node_modules. esm.sh is what Supabase's own vanilla-JS
 * quickstart uses for this.
 *
 * Only the publishable (anon) key lives here — see js/supabaseConfig.js for
 * why that is safe to ship. Every table and RPC this client can reach is
 * bounded by the RLS policies and grants in supabase/migrations, not by
 * keeping anything in this file secret.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabaseConfig.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
