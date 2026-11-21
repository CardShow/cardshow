// Calls the public Postgres functions (search_listings, get_listing, get_dealer_storefront,
// list_upcoming_shows) with the public key. The buyer site never has the service key.
import { env } from './env.js';

export class ApiError extends Error {}

export async function rpc(name, args = {}, { timeoutMs = 6000, fetchImpl = fetch } = {}) {
  const url = env.supabaseUrl(), key = env.anonKey();
  if (!url || !key) throw new ApiError('not_configured');
  const res = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let msg = `${name}: HTTP ${res.status}`;
    try { const b = await res.json(); if (b?.message) msg = `${name}: ${b.message}`; } catch {}
    throw new ApiError(msg);
  }
  return res.json();
}
