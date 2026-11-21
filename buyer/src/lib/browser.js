// Browser-side Supabase client (sign-in, saved searches). Same project and same saved session as the
// dealer app on getcardshow.com, so a dealer is already signed in here. Public key only.
import { createClient } from '@supabase/supabase-js';

let client = null;
export function sb() {
  if (client) return client;
  const d = document.documentElement.dataset;
  if (!d.sbUrl || !d.sbKey) throw new Error('not_configured');
  client = createClient(d.sbUrl, d.sbKey, { auth: { flowType: 'implicit', persistSession: true, autoRefreshToken: true } });
  return client;
}

export async function currentUser() {
  try { const { data } = await sb().auth.getSession(); return data?.session?.user || null; } catch { return null; }
}

// A search waiting to be saved once the buyer signs in.
const PENDING = 'cardshowPendingSave';
export function setPendingSave(v) { try { sessionStorage.setItem(PENDING, JSON.stringify(v)); } catch {} }
export function takePendingSave() {
  try { const v = JSON.parse(sessionStorage.getItem(PENDING) || 'null'); sessionStorage.removeItem(PENDING); return v; } catch { return null; }
}

export async function saveSearch(params, name) {
  const { data, error } = await sb().from('saved_searches').insert({ params, name, alerts: true }).select('id').single();
  if (error) throw error;
  return data;
}
