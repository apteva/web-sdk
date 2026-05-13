# Changelog

## 0.1.0 — 2026-05-13

Initial release.

- `ApteveClient` — base client with session-cookie + Bearer + `?api_key=` auth carriers, `credentials: include` for cross-origin cookie flow, configurable timeout, `onUnauthorized` hook.
- `client.auth` namespace — `register`, `login`, `logout`, `me`, `status`, `changePassword`, `listKeys`, `createKey`, `deleteKey`.
- `client.app(name)` — typed handle for any installed app: `get/post/put/patch/del` for HTTP routes + `tool(name, args)` for MCP calls. Generic type parameter for response shape.
- `unwrapMCP` — exposed standalone for callers that want to handle the JSON-RPC envelope themselves.
- Window helpers — `readAptevaInjection`, `pickKioskKey`, `pickBaseURL` for UIs hosted as static apps on apteva-server itself.
- `client.sseURL` + `client.app(...).mcpURL` builders for `EventSource` / `<iframe>` / external clients that can't go through `fetch`.
- `ApteveError` with `.status`, `.body`, `.code`, `.isUnauthorized()`, `.isNotFound()`.
- 43 tests covering carriers, auth, app HTTP/MCP, envelope unwrap, window helpers.
