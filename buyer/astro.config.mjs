// CardShow Marketplace buyer site. Every page is rendered on the server (fast on phones, readable by
// Google, link previews and AI assistants). Deployed as its own Netlify site (base directory buyer/);
// getcardshow.com proxies /search, /c/*, /d/*, /account and /_astro/* to it (see the repo's _redirects).
import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';

export default defineConfig({
  output: 'server',
  adapter: netlify(),
  site: process.env.MARKETPLACE_SITE_URL || 'https://getcardshow.com',
  trailingSlash: 'never',
  build: { format: 'file' },
  devToolbar: { enabled: false },
  security: { checkOrigin: true },
  // Grid tiles use Netlify's image service for small copies of dealer photos. It only exists on Netlify,
  // so it's on for builds made there (NETLIFY=true) and off for astro dev / tests. BUYER_IMAGE_CDN=false turns it off.
  vite: { define: { __CS_IMAGE_CDN__: JSON.stringify(process.env.NETLIFY === 'true' && process.env.BUYER_IMAGE_CDN !== 'false') } },
});
