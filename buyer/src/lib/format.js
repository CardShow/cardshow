// Display helpers shared by every page.
export function money(cents, { cents: showCents = false } = {}) {
  if (cents === null || cents === undefined || cents === '') return '';
  const n = Number(cents) / 100;
  const whole = Number.isInteger(n) && !showCents;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
}

export function gradeLabel(l) {
  if (!l) return '';
  if (l.grader && l.grade !== undefined && l.grade !== null) return `${String(l.grader).toUpperCase()} ${String(l.grade).replace(/\.0+$/, '')}`;
  return l.grade_key && l.grade_key !== 'Raw' ? l.grade_key : 'Raw';
}

// "14% under market" / "8% over market" / "At market"
export function pctLabel(pct) {
  if (pct === null || pct === undefined) return '';
  const d = Math.round((1 - Number(pct)) * 100);
  if (d === 0) return 'At market';
  return d > 0 ? `${d}% under market` : `${-d}% over market`;
}

export function photoUrl(supabaseUrl, path) {
  return path && supabaseUrl ? `${supabaseUrl}/storage/v1/object/public/listing-photos/${path}` : null;
}

// A resized copy of a dealer photo from Netlify's image service (/.netlify/images). Both Netlify sites allow
// the listing-photos bucket as a remote image source (netlify.toml [images]); the copy is cached at the CDN.
export function thumbUrl(url, width) {
  return `/.netlify/images?url=${encodeURIComponent(url)}&w=${width}&q=72`;
}

// The listing's best image: the dealer's own photo, else the catalog image the dealer picked.
// thumb: a width for grid tiles (dealer photos only; catalog images are already small).
// cdn: false outside Netlify (astro dev and tests), where /.netlify/images doesn't exist.
export function imageFor(l, { supabaseUrl, siteUrl, thumb = 0, cdn = false }) {
  const img = l?.image || {};
  const photo = photoUrl(supabaseUrl, img.photo_path);
  if (photo) return { url: thumb && cdn ? thumbUrl(photo, thumb) : photo, full: photo, kind: 'photo' };
  if (img.stock_image_url) return { url: siteUrl + img.stock_image_url, kind: 'catalog' };
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function ymd(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null; }
// "Oct 9", "Oct 9–11", "Oct 30 – Nov 1"
export function dateRange(start, end) {
  const a = ymd(start), b = ymd(end) || a;
  if (!a) return '';
  if (a.y === b.y && a.m === b.m) return a.d === b.d ? `${MONTHS[a.m]} ${a.d}` : `${MONTHS[a.m]} ${a.d}–${b.d}`;
  return `${MONTHS[a.m]} ${a.d} – ${MONTHS[b.m]} ${b.d}`;
}

export function place(show) {
  if (!show) return '';
  return [show.city, show.state].filter(Boolean).join(', ');
}

export function timeAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const days = Math.floor((now - t) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Shows from The Card Shop Finder (CSF): their terms say every listing of one credits "via The Card Shop Finder",
// linked to the event's url exactly as CSF sent it (show.source_url), and shows only listing facts.
export const CSF_CREDIT = 'via The Card Shop Finder';
export function fromFeed(show) { return !!(show && show.attribution && show.source_url); }
function time12(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  if (!m) return '';
  const h = +m[1], ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
  return `${h12}${m[2] === '00' ? '' : ':' + m[2]} ${ap}`;
}
// "9 AM–5 PM" (local, as CSF sends it), "Hours TBD" when either is missing. '' for shows not from the feed.
export function showHours(show) {
  if (!fromFeed(show)) return '';
  const a = time12(show.time_start), b = time12(show.time_end);
  return a && b ? `${a}–${b}` : 'Hours TBD';
}
// 0 → "Free entry", 10 → "$10 entry", 7.5 → "$7.50 entry", null → ''.
export function admissionText(price) {
  if (price === null || price === undefined || price === '') return '';
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return '';
  return n === 0 ? 'Free entry' : `${money(Math.round(n * 100))} entry`;
}
