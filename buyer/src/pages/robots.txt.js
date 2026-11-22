// getcardshow.com/robots.txt (proxied here by the main site). See src/lib/seo.js.
import { env } from '../lib/env.js';
import { buildRobots } from '../lib/seo.js';

export function GET() {
  return new Response(buildRobots({ indexing: env.indexing(), site: env.siteUrl() }), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600',
               'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=3600' },
  });
}
