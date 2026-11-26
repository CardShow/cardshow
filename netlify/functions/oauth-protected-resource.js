// OAuth protected-resource metadata (RFC 9728) for the seller MCP server at /mcp/seller.
// Served at /.well-known/oauth-protected-resource and /.well-known/oauth-protected-resource/mcp/seller
// (see _redirects). MCP clients read it after a 401 to find the authorization server: Supabase Auth's
// OAuth 2.1 server for this project. The resource URL follows the request's host so deploy previews work.

// No scopes_supported on purpose: CardShow's scopes are chosen on CardShow's consent page and stored in
// mcp_client_grants. Advertising them could make clients ask Supabase for scopes it doesn't know.

function host(event) {
  const h = event.headers || {};
  return String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
}

exports.handler = async (event) => {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const site = host(event) ? `https://${host(event)}` : (process.env.MARKETPLACE_SITE_URL || 'https://getcardshow.com').replace(/\/$/, '');
  if (!url) return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: '{"error":"not_configured"}' };
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' },
    body: JSON.stringify({
      resource: `${site}/mcp/seller`,
      resource_name: 'CardShow for dealers',
      authorization_servers: [`${url}/auth/v1`],
      bearer_methods_supported: ['header'],
      resource_documentation: `${site}/`,
    }),
  };
};
