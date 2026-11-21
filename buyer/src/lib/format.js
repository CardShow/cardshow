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

// The listing's best image: the dealer's own photo, else the catalog image the dealer picked.
export function imageFor(l, { supabaseUrl, siteUrl }) {
  const img = l?.image || {};
  const photo = photoUrl(supabaseUrl, img.photo_path);
  if (photo) return { url: photo, kind: 'photo' };
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
