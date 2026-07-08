---
'@modelcontextprotocol/client': patch
---

`StreamableHTTPClientTransport` no longer captures the `Mcp-Session-Id` header from error responses. Previously the header was stored from any response before the status check, so an error reply that carried a session id injected session state into the connection — most visibly in `versionNegotiation: { mode: 'auto' }`, where a legacy server answering the probe with a 404-plus-session-id poisoned the fallback `initialize` (it presented a session id the server never issued, which spec-conforming stateful servers reject, failing a connect that would otherwise succeed). Session ids are now only captured from successful responses, matching the spec's assignment point; error responses contribute nothing to session state.
