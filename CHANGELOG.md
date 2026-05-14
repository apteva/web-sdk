# Changelog

## 0.3.0 — 2026-05-14

Adds first-class **agents** and **activity/telemetry** surfaces — previously only reachable through the raw `client.get` escape hatch.

- `client.agents` — `list`, `get`, `status`, `threads`, `channels`, `chatHistory`. Maps onto `/api/agents/*`.
- `client.telemetry` — `query` (filtered event read), `timeline`, `stats`, and `stream` (live SSE feed). `stream` normalizes the server's occasional double-stringified `data` field.
- `client.subscribe(path, params, onEvent, opts?)` — generic SSE wrapper `telemetry.stream` is built on. Injectable `EventSource` via `opts.EventSource` for Node < 22 / test doubles.
- New exported types: `Agent`, `AgentStatus`, `Thread`, `ChannelInfo`, `ChatHistoryMessage`, `TelemetryEvent`, `TelemetryType`, `TelemetryQuery`, `TelemetryStats`, `TelemetryPeriod`, `TimelineBucket`, `StreamHandle`, `SubscribeOptions`, `EventSourceLike`, `EventSourceCtor`.
- 19 new tests (62 total).


## 0.2.0 — 2026-05-13

**Breaking**: class + interface renamed from `Apteve*` to `Apteva*` (typo fix — org name is `apteva`, not `apteve`).

- `ApteveClient` → `AptevaClient`
- `ApteveError` → `AptevaError`
- `ApteveClientOptions` → `AptevaClientOptions`

Same public surface, same behavior. Anyone on 0.1.0 (if any) renames the imports and is good.


## 0.1.0 — 2026-05-13

Initial release.

- `AptevaClient` — base client with session-cookie + Bearer + `?api_key=` auth carriers, `credentials: include` for cross-origin cookie flow, configurable timeout, `onUnauthorized` hook.
- `client.auth` namespace — `register`, `login`, `logout`, `me`, `status`, `changePassword`, `listKeys`, `createKey`, `deleteKey`.
- `client.app(name)` — typed handle for any installed app: `get/post/put/patch/del` for HTTP routes + `tool(name, args)` for MCP calls. Generic type parameter for response shape.
- `unwrapMCP` — exposed standalone for callers that want to handle the JSON-RPC envelope themselves.
- Window helpers — `readAptevaInjection`, `pickKioskKey`, `pickBaseURL` for UIs hosted as static apps on apteva-server itself.
- `client.sseURL` + `client.app(...).mcpURL` builders for `EventSource` / `<iframe>` / external clients that can't go through `fetch`.
- `AptevaError` with `.status`, `.body`, `.code`, `.isUnauthorized()`, `.isNotFound()`.
- 43 tests covering carriers, auth, app HTTP/MCP, envelope unwrap, window helpers.
