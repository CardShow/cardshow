// Fallback for MCP clients that look for authorization-server metadata on the MCP server's own origin
// (/.well-known/oauth-authorization-server, the 2025-03-26 MCP spec) instead of following the protected-resource
// metadata. Relays Supabase Auth's OAuth server metadata unchanged (its issuer stays Supabase).

exports.handler = async () => {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!url) return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: '{"error":"not_configured"}' };
  try {
    const res = await fetch(`${url}/.well-known/oauth-authorization-server/auth/v1`, { signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    return {
      statusCode: res.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': res.ok ? 'public, max-age=3600' : 'no-store' },
      body: res.ok ? text : JSON.stringify({ error: 'authorization_server_unavailable' }),
    };
  } catch {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'authorization_server_unavailable' }) };
  }
};
