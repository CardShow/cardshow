// Headers on every page: robots (noindex until BUYER_SITE_INDEXING=true) and a few safe defaults.
// Pages set their own caching through Astro.locals.cache (seconds the CDN may keep them; 0 = never).
import { env } from './lib/env.js';

export async function onRequest(ctx, next) {
  ctx.locals.cache = 60;
  const res = await next();
  if (!env.indexing()) res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  const secs = ctx.locals.cache;
  if ((res.headers.get('content-type') || '').includes('text/html') && !res.headers.has('Cache-Control')) {
    res.headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    res.headers.set('Netlify-CDN-Cache-Control', secs > 0
      ? `public, durable, s-maxage=${secs}, stale-while-revalidate=${secs * 5}` : 'no-store');
  }
  return res;
}
