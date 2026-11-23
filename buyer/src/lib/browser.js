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

// A bundle offer being put together: cards from one dealer, kept on this device until it's sent.
// { dealer: { handle, name }, items: [{ id, title, price_cents, url }] }
const BUNDLE = 'cardshowBundle';
export const BUNDLE_MAX = 20;
export function getBundle() {
  try { const b = JSON.parse(localStorage.getItem(BUNDLE) || 'null'); return b && Array.isArray(b.items) ? b : null; } catch { return null; }
}
function putBundle(b) {
  try {
    if (b && b.items.length) localStorage.setItem(BUNDLE, JSON.stringify(b));
    else localStorage.removeItem(BUNDLE);
  } catch {}
  window.dispatchEvent(new CustomEvent('cardshow-bundle'));
}
export function inBundle(id) { return !!getBundle()?.items.some(i => i.id === id); }
// → 'added' | 'other_dealer' | 'full'. With replace, a bundle from another dealer is dropped first.
export function addToBundle(dealer, item, { replace = false } = {}) {
  let b = getBundle();
  if (b && b.dealer?.handle !== dealer.handle) { if (!replace) return 'other_dealer'; b = null; }
  b = b || { dealer, items: [] };
  if (b.items.some(i => i.id === item.id)) return 'added';
  if (b.items.length >= BUNDLE_MAX) return 'full';
  b.items.push(item);
  putBundle(b);
  return 'added';
}
export function dropFromBundle(id) {
  const b = getBundle();
  if (!b) return;
  b.items = b.items.filter(i => i.id !== id);
  putBundle(b);
}
export function emptyBundle() { putBundle(null); }

export async function saveSearch(params, name) {
  const { data, error } = await sb().from('saved_searches').insert({ params, name, alerts: true }).select('id').single();
  if (error) throw error;
  return data;
}
