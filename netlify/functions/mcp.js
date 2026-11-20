// CardShow read-only MCP server (Marketplace Phase 1, plan v4).
// Lets AI assistants (Claude, ChatGPT, etc.) search CardShow listings and upcoming shows.
//
// Transport: MCP "Streamable HTTP", stateless — each POST carries one JSON-RPC message (or a batch)
// and gets a JSON response. No SSE stream, no sessions. Served at /mcp (see _redirects).
//
// Rules (plan v4, agent rules 12–17):
//   * Public data only: active, non-early-access listings and listed shows (the database functions
//     search_listings / get_listing / list_upcoming_shows enforce this, called with the anon key).
//   * No buying, holding or offers in Phase 1.
//   * Every result links to its CardShow page with ?ref=agent-{client}.
//   * Rate limited per client IP; every tool call logged in agent_actions (actor_type external_agent).
//
// Off unless MARKETPLACE_MCP_ENABLED is exactly "true". Needs SUPABASE_URL, SUPABASE_ANON_KEY
// (data) and SUPABASE_SERVICE_KEY (rate limits + logging). MARKETPLACE_SITE_URL sets link base.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { lookupPlace } = require('../lib/us-places');

const SERVER = { name: 'cardshow', title: 'CardShow', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PER_MINUTE = () => parseInt(process.env.MCP_RATE_PER_MINUTE || '60', 10) || 60;
const PER_DAY = () => parseInt(process.env.MCP_RATE_PER_DAY || '2000', 10) || 2000;
const SITE = () => (process.env.MARKETPLACE_SITE_URL || 'https://getcardshow.com').replace(/\/$/, '');

const INSTRUCTIONS = 'CardShow lists trading cards for sale at physical card shows and card shops, plus cards dealers ship. ' +
  'Use search_cards to find listings (prices in US cents; "comp" is the online market value from Card Hedge, and ' +
  'pct_of_comp is the asking price as a share of it). Use list_upcoming_shows and get_show_inventory to find cards at ' +
  'shows near a place and date. This server is read-only: send the person to the listing URL to buy, hold or make an offer.';

const FILTER_PROPS = {
  category: { type: 'string', description: 'Sports, TCG or Non-Sport' },
  subcategory: { type: 'string', description: 'Sport, game or franchise, e.g. Baseball, Pokémon, Marvel' },
  player: { type: 'string', description: 'Player or character name (partial match)' },
  year_min: { type: 'integer' }, year_max: { type: 'integer' },
  set: { type: 'string', description: 'Set name (partial match), e.g. Prizm' },
  number: { type: 'string', description: 'Card number' },
  parallel: { type: 'string', description: 'Parallel or variant (partial match), e.g. Silver' },
  grader: { type: 'string', description: 'PSA, BGS, CGC, SGC, TAG…' },
  grade_min: { type: 'number' }, grade_max: { type: 'number' },
  raw: { type: 'boolean', description: 'true = ungraded only, false = graded only' },
  price_min_cents: { type: 'integer' }, price_max_cents: { type: 'integer' },
  comp_min_cents: { type: 'integer' }, comp_max_cents: { type: 'integer' },
  deals_only: { type: 'boolean', description: 'Only listings priced 10%+ under their online comp' },
  sale_mode: { type: 'string', enum: ['ship', 'local_pickup'] },
  state: { type: 'string', description: 'Two-letter US state of the show the card is at' },
  near: { type: 'object', description: 'Cards at shows near a place: a US city and state, or lat/lng', properties: {
    city: { type: 'string', description: 'e.g. Anaheim' }, state: { type: 'string', description: 'Two-letter state, e.g. CA' },
    lat: { type: 'number' }, lng: { type: 'number' }, miles: { type: 'number', description: 'Default 25' } } },
  date_from: { type: 'string', description: 'YYYY-MM-DD: show runs on or after' },
  date_to: { type: 'string', description: 'YYYY-MM-DD: show starts on or before' },
  dealer: { type: 'string', description: 'Dealer handle' },
  sort: { type: 'string', enum: ['best', 'price_asc', 'price_desc', 'deal', 'newest', 'distance'] },
  limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20' },
  offset: { type: 'integer', minimum: 0 },
};

const TOOLS = [
  {
    name: 'search_cards',
    title: 'Search card listings',
    description: 'Search active CardShow listings by text and filters. Returns listings with price, online comp value, ' +
      'percent of comp, grade/cert, dealer, the next show the card will be at, and a link to its page.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'e.g. "Charizard PSA 10"' }, ...FILTER_PROPS } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_listing',
    title: 'Get one listing',
    description: 'Details for one listing: price, comp value and range with when it was updated, GTCR status, ' +
      'location (show and table) and availability.',
    inputSchema: { type: 'object', properties: { listing_id: { type: 'string', description: 'Listing id (uuid)' } }, required: ['listing_id'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_upcoming_shows',
    title: 'List upcoming card shows',
    description: 'Upcoming card shows, optionally near a point or in a state and date range, with the number of listed cards.',
    inputSchema: { type: 'object', properties: {
      near: FILTER_PROPS.near, state: FILTER_PROPS.state, date_from: FILTER_PROPS.date_from, date_to: FILTER_PROPS.date_to,
      limit: { type: 'integer', minimum: 1, maximum: 50 } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_show_inventory',
    title: 'Search a show',
    description: 'Search the listings at one show (use list_upcoming_shows for show ids).',
    inputSchema: { type: 'object', properties: { show_id: { type: 'string' }, query: { type: 'string' }, ...FILTER_PROPS }, required: ['show_id'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

// ── helpers ────────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dollars = c => (c == null ? null : `$${(c / 100).toFixed(2)}`);

function clientSlug(event, body) {
  const fromInit = body?.method === 'initialize' ? body?.params?.clientInfo?.name : null;
  const h = event.headers || {};
  const ua = h['user-agent'] || h['User-Agent'] || '';
  const raw = fromInit || h['mcp-client'] || ua.split(/[\s/]/)[0] || 'unknown';
  return String(raw).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unknown';
}
function clientIp(event) {
  const h = event.headers || {};
  return h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}
function ipKey(ip) {
  return crypto.createHash('sha256').update(`mcp:${ip}:${process.env.SUPABASE_URL || ''}`).digest('hex').slice(0, 24);
}

function linkify(path, client) {
  if (!path) return null;
  const sep = path.includes('?') ? '&' : '?';
  return `${SITE()}${path}${sep}ref=agent-${client}`;
}

// Listing as returned to agents: links absolute, money also in dollars.
function shapeListing(l, client) {
  if (!l || l.error) return l;
  const out = { ...l, url: linkify(l.url, client), price: dollars(l.price_cents) };
  if (l.comp) out.comp = { ...l.comp, value: dollars(l.comp.value_cents), low: dollars(l.comp.low_cents), high: dollars(l.comp.high_cents) };
  if (l.dealer) out.dealer = { ...l.dealer, url: linkify(l.dealer.url, client) };
  if (l.image?.stock_image_url) out.image = { ...l.image, stock_image_url: `${SITE()}${l.image.stock_image_url}` };
  if (l.show?.id) out.show = { ...l.show, url: linkify(`/show.html?id=${l.show.id}`, client) };
  return out;
}

function searchParams(args) {
  const p = {};
  for (const k of Object.keys(FILTER_PROPS)) if (args[k] !== undefined && args[k] !== null && args[k] !== '') p[k] = args[k];
  if (args.query) p.q = String(args.query).slice(0, 200);
  if (args.near) p.near = resolveNear(args.near);
  p.limit = Math.min(Math.max(parseInt(args.limit ?? 20, 10) || 20, 1), 50);
  return p;
}

// near: {city, state} → {lat, lng} from the Census Gazetteer. Throws a tool error for an unknown place.
function resolveNear(near) {
  if (!near || typeof near !== 'object') return undefined;
  const miles = near.miles;
  if (Number.isFinite(Number(near.lat)) && Number.isFinite(Number(near.lng)) && near.lat !== '' && near.lng !== '') {
    return { lat: Number(near.lat), lng: Number(near.lng), ...(miles != null ? { miles } : {}) };
  }
  if (near.city && near.state) {
    const p = lookupPlace(near.city, near.state);
    if (!p) throw toolError(`Couldn't find ${near.city}, ${near.state}. Use a US city and its two-letter state.`);
    return { lat: p.lat, lng: p.lng, ...(miles != null ? { miles } : {}) };
  }
  throw toolError('near needs a city and state, or lat and lng');
}

// ── tool calls ─────────────────────────────────────────────────────────────
async function callTool(name, args, { data, client }) {
  args = args && typeof args === 'object' ? args : {};
  if (name === 'search_cards' || name === 'get_show_inventory') {
    if (name === 'get_show_inventory' && !args.show_id) throw toolError('show_id is required');
    const p = searchParams(args);
    if (name === 'get_show_inventory') p.show_id = String(args.show_id);
    const { data: res, error } = await data.rpc('search_listings', { p });
    if (error) throw new Error(error.message);
    const results = (res?.results || []).map(l => shapeListing(l, client));
    return { result: { total: res?.total ?? 0, offset: res?.offset ?? 0, results }, ids: results.map(r => r.id) };
  }
  if (name === 'get_listing') {
    if (!UUID_RE.test(String(args.listing_id || ''))) throw toolError('listing_id must be a listing uuid');
    const { data: res, error } = await data.rpc('get_listing', { p_id: args.listing_id });
    if (error) throw new Error(error.message);
    if (res?.error) return { result: { error: res.error }, ids: [] };
    // Ask for a fresh value in the background if this one is overdue (never waits).
    data.rpc('request_card_value_refresh', { p_listing_id: args.listing_id }).then(() => {}, () => {});
    return { result: shapeListing(res, client), ids: [res.id] };
  }
  if (name === 'list_upcoming_shows') {
    const p = {};
    for (const k of ['state', 'date_from', 'date_to', 'limit']) if (args[k] !== undefined) p[k] = args[k];
    if (args.near) p.near = resolveNear(args.near);
    const { data: res, error } = await data.rpc('list_upcoming_shows', { p });
    if (error) throw new Error(error.message);
    return { result: { shows: (res || []).map(s => ({ ...s, url: linkify(s.url, client) })) }, ids: [] };
  }
  throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
}
function toolError(msg) { return Object.assign(new Error(msg), { toolInput: true }); }

// ── JSON-RPC ───────────────────────────────────────────────────────────────
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleMessage(msg, ctx) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return msg && msg.id !== undefined ? rpcError(msg.id, -32600, 'Invalid Request') : rpcError(null, -32600, 'Invalid Request');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null;            // notifications/initialized etc.: nothing to send back
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const want = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return rpcResult(id, {});
    case 'tools/list': return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name, args = params?.arguments || {};
      if (!TOOLS.some(t => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const { result, ids } = await callTool(name, args, ctx);
        ctx.log({ tool: name, args, ids, ok: true });
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (err) {
        ctx.log({ tool: name, args, ids: [], ok: false, error: err.message });
        if (err.rpcCode) return rpcError(id, err.rpcCode, err.message);
        const text = err.toolInput ? err.message : 'CardShow search is unavailable right now. Try again shortly.';
        return rpcResult(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    default: return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization',
};
const json = (statusCode, body, extra = {}) => ({ statusCode, headers: { 'Content-Type': 'application/json', ...CORS, ...extra }, body: JSON.stringify(body) });

async function handle(event, deps = {}) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (process.env.MARKETPLACE_MCP_ENABLED !== 'true') return json(404, rpcError(null, -32000, 'CardShow MCP is not enabled yet'));
  if (event.httpMethod === 'GET') return { statusCode: 405, headers: { Allow: 'POST', ...CORS }, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: { Allow: 'POST', ...CORS }, body: '' };

  let body;
  try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : (event.body || '')); }
  catch { return json(400, rpcError(null, -32700, 'Parse error')); }

  const url = process.env.SUPABASE_URL;
  const data = deps.data || (url && process.env.SUPABASE_ANON_KEY ? createClient(url, process.env.SUPABASE_ANON_KEY) : null);
  const svc = deps.svc !== undefined ? deps.svc : (url && process.env.SUPABASE_SERVICE_KEY ? createClient(url, process.env.SUPABASE_SERVICE_KEY) : null);
  if (!data) return json(503, rpcError(null, -32000, 'CardShow MCP is not configured'));

  const msgs = Array.isArray(body) ? body : [body];
  if (!msgs.length || msgs.length > 20) return json(400, rpcError(null, -32600, 'Invalid Request'));
  const client = clientSlug(event, msgs.find(m => m?.method === 'initialize') || msgs[0]);

  // Rate limit tool calls only (initialize / list are cheap).
  const toolCalls = msgs.filter(m => m?.method === 'tools/call').length;
  if (toolCalls && svc) {
    const key = ipKey(clientIp(event));
    const [m, d] = await Promise.all([
      svc.rpc('rate_limit_hit', { p_key: `mcp:m:${key}`, p_window_seconds: 60, p_max: PER_MINUTE() }),
      svc.rpc('rate_limit_hit', { p_key: `mcp:d:${key}`, p_window_seconds: 86400, p_max: PER_DAY() }),
    ]);
    const blocked = [m, d].find(r => r?.data && r.data.allowed === false);
    if (blocked) {
      const retry = Math.max(1, Math.ceil((new Date(blocked.data.reset_at) - Date.now()) / 1000));
      const errs = msgs.filter(x => x && x.id !== undefined).map(x => rpcError(x.id, -32000, 'Rate limit reached. Try again later.'));
      return json(429, Array.isArray(body) ? errs : errs[0], { 'Retry-After': String(retry) });
    }
  }

  const logs = [];
  const ctx = {
    data, client,
    log: (entry) => logs.push({
      actor_type: 'external_agent', client, action: 'search', tool: entry.tool,
      target_ids: (entry.ids || []).filter(x => UUID_RE.test(String(x))).slice(0, 50),
      reason: entry.ok ? null : String(entry.error || '').slice(0, 200),
      detail: { args: entry.args, results: (entry.ids || []).length, ok: entry.ok },
    }),
  };
  const out = [];
  for (const m of msgs) { const r = await handleMessage(m, ctx); if (r) out.push(r); }
  if (logs.length && svc) {
    const { error } = await svc.from('agent_actions').insert(logs);
    if (error) console.warn('[mcp] log failed:', error.message);
  }
  if (!out.length) return { statusCode: 202, headers: CORS, body: '' };
  return json(200, Array.isArray(body) ? out : out[0]);
}

exports.handler = (event) => handle(event);
exports._test = { handle, TOOLS, shapeListing, clientSlug, searchParams };
