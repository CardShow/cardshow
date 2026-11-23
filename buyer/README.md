# CardShow Marketplace — buyer site

Astro, rendered on the server, deployed as its own Netlify site. getcardshow.com serves it at
`/search`, `/shows`, `/c/*`, `/d/*`, `/s/*`, `/account` and `/_astro/*` through proxy rules in the repo's `_redirects`,
so the dealer app, show pages and printed QR codes keep their URLs.

| Page | What |
|---|---|
| `/search` | All public listings. Filters in the URL: `q`, `category`, `graded` (graded/raw), `grader`, `min`/`max` ($), `deals=1`, `how` (ship/pickup), `when` (weekend/month), `state`, `loc` (ZIP code or city, state) or `lat`/`lng` (Use my location) with `miles`, `sort`, `page`. Save search (signs in first). `?saved=<id>` opens a saved search (link in alert emails). |
| `/c/<id>-<slug>` | One listing: photo, price, market value and % vs market, GTCR check, show + table, WhatsApp / Instagram contact, details, schema.org Product/Offer. Wrong slug → 301 to the right one. |
| `/d/<handle>` | A dealer's listed cards, with search, category, graded/raw, price, deals and sort. |
| `/shows` | Upcoming listed shows: near a ZIP/city, state, this weekend / next 30 days; card count per show, links to `/s/<key>`. |
| `/s/<key>` | One show (key = slug, else id; an id with a slug → 301): details, dealers with table numbers, its cards with search and filters, schema.org Event. |
| `/account` | Sign in / create account / reset password (same Supabase accounts as the dealer app), saved searches with email on/off. |
| `/robots.txt`, `/sitemap.xml` | For the whole getcardshow.com domain (the main site proxies them here). Marketplace pages closed to crawlers and no sitemap advertised until `BUYER_SITE_INDEXING=true`. |

Data comes only from the public database functions (`search_listings`, `get_listing`, `get_dealer_storefront`, `get_show_page`,
`request_card_value_refresh`) with the public key; saved searches use the signed-in buyer's own rows.

## Netlify setup (once)
1. Netlify → Add new site → Import from Git → this repo.
2. **Site name `cardshow-buyer`** (the proxy rules point at `cardshow-buyer.netlify.app`; if you pick another
   name, change the host in the repo's `_redirects`).
3. **Base directory `buyer`**. Build command and publish directory come from `buyer/netlify.toml`.
4. Environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (same values as the main site),
   optional `MARKETPLACE_SITE_URL` (default `https://getcardshow.com`). Leave `BUYER_SITE_INDEXING` unset until
   launch; every page is noindex until it's `true`.
5. Grid tiles load resized dealer photos from Netlify Image CDN (`/.netlify/images`); `buyer/netlify.toml` and the
   root `netlify.toml` both allow the `listing-photos` bucket. Set `BUYER_IMAGE_CDN=false` to turn it off.
6. Supabase → Authentication → URL Configuration → Redirect URLs: add `https://getcardshow.com/account`
   (account confirmation and password-reset emails land there).

## Develop and test
```bash
npm install
SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run dev     # http://localhost:4321/search
npm test                                              # URL ↔ search params
node test/site.e2e.mjs "iPhone 13"                    # pages end to end against test/mock-supabase.mjs
node test/site.e2e.mjs "Desktop Chrome"
```
