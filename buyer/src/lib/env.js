// Server-side settings (Netlify environment variables; `astro dev` reads them from the shell).
const read = k => (typeof process !== 'undefined' && process.env?.[k]) || import.meta.env?.[k] || '';

export const env = {
  supabaseUrl: () => read('SUPABASE_URL').replace(/\/$/, ''),
  anonKey: () => read('SUPABASE_ANON_KEY'),
  // Main site (stock card images, show pages, the dealer app). The buyer site is served under it.
  siteUrl: () => (read('MARKETPLACE_SITE_URL') || 'https://getcardshow.com').replace(/\/$/, ''),
  // Resized tile images through Netlify's image service: on for builds made on Netlify (see astro.config.mjs).
  imageCdn: () => typeof __CS_IMAGE_CDN__ !== 'undefined' && __CS_IMAGE_CDN__ === true,
  // Off until launch: every page says noindex.
  indexing: () => read('BUYER_SITE_INDEXING') === 'true',
};
