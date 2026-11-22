// getcardshow.com/sitemap.xml (proxied here by the main site): the landing page, search, every public
// listing (newest 5,050), dealer storefronts and upcoming show pages. See src/lib/seo.js.
import { env } from '../lib/env.js';
import { rpc } from '../lib/api.js';
import { buildSitemap, collectSitemap } from '../lib/seo.js';

export async function GET() {
  try {
    const entries = await collectSitemap({ rpc, site: env.siteUrl() });
    return new Response(buildSitemap(entries), {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600',
                 'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=3600, stale-while-revalidate=86400' },
    });
  } catch (e) {
    console.error('[sitemap]', e?.message);
    return new Response('Sitemap unavailable, try again shortly.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '600', 'Cache-Control': 'no-store' },
    });
  }
}
