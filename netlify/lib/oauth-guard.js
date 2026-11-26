// Assistant (OAuth) tokens from Supabase's OAuth server carry a client_id claim. They're for the seller MCP
// server only: every other function that accepts a dealer's sign-in refuses them, so a connected assistant
// can't change GTCR consent, run admin jobs and so on outside the MCP tools. Normal app sessions pass.

function bearerClaims(event) {
  const h = event?.headers || {};
  const auth = String(h.authorization || h.Authorization || '');
  const m = /^Bearer\s+([^.\s]+)\.([^.\s]+)\./i.exec(auth.trim());
  if (!m) return null;
  try { return JSON.parse(Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch { return null; }
}
function isAssistantToken(event) {
  const c = bearerClaims(event);
  return !!(c && c.client_id);
}
function refuseOAuthClient(handler) {
  return async (event, context) => {
    if (isAssistantToken(event)) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'assistant_token_not_allowed', message: 'Assistant tokens can only use the CardShow MCP tools.' }),
      };
    }
    return handler(event, context);
  };
}
module.exports = { isAssistantToken, refuseOAuthClient };
