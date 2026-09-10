## 0.9.0

- Add `credential: "auth" | "platform"` to app handles, extensions and frontend
  loaders. HTTP, MCP and SSE use the selected credential within one managed session.
- Refresh Auth and platform credentials independently with shared renewal across
  handles. Auth routes remain usable when platform minting is unavailable.
- Prevent stale mints and old-session 401s from overwriting a newer session.
  Both stream types reconnect at their credential expiry and close on logout or
  detected session revocation. No credential fallback or HTTP replay after a 401.
- Restrict managed forwarding to the configured server, project and scoped app
  routes; reject escaped paths, URL credentials, header overrides and redirects.
- Managed `getAccessToken()` now returns `undefined`; use app handles instead.
  Host-owned opaque-token transport retains its existing behavior.
- Add mixed-session regression tests and an opt-in integration harness using real
  Auth, API and Telephony handlers. Platform mint/Conversations gateway are fixtures.
- Requires Auth v0.12.0 or newer. No additional Auth or server release required.

## 0.8.0

- Add unified Auth app login/signup, user lookup, session metadata, automatic
  platform-token renewal and logout through `AptevaClient({ auth })`.
- Coordinate Auth refresh rotation and platform renewal, preserve rotated Auth
  credentials during mint outages, and ignore late results after session changes.
- Keep app-user credentials isolated from API keys/cookies; reconnect managed
  streams at expiry and close them on logout. Existing SDK auth mode is unchanged.
- Requires Auth v0.12.0 with explicit role bindings and platform policy lifetimes
  of at most 60 seconds. Sessions are memory-only; reloads require login.

# Changelog

## 0.7.0 — 2026-09-07

- Load app-owned frontend bundles from installed apps with `client.apps.load`; no per-app npm package is required.
- Share authenticated scoped requests, verify asset hashes, check versions/React compatibility, and create fresh app clients and UI contexts.
- Reference-count scoped styles and expose cancellation and disposal.
- Preserve local extension/registry APIs and existing chat transports.

## 0.6.0 — 2026-09-07

- Add typed app-owned extensions through `defineAppExtension` and `client.use`.
- Add project/install-scoped app handles, HTTP/MCP request options, and app SSE subscriptions sharing live client credentials.
- Add framework-independent component references, manifest metadata types and a local export registry.
- Expose installed-app discovery and explicit metadata/version compatibility checks.
- Fix caller cancellation being overridden by request timeouts; retain cancellation and timeouts through response-body reads.
- Add abortable fetch subscriptions with SSE resume IDs, optional cursor queries, bounded opt-in deduplication, configurable reconnect delay and terminal auth handling.
- Add coordinated host-owned access-token renewal without automatically replaying HTTP requests.
- Preserve legacy Channel Chat APIs; app-specific extensions and UI stay in app-owned packages.

## 0.5.5 — 2026-08-15

- Add a generic, opaque `accessToken` credential to `AptevaClient`, including
  runtime `setAccessToken(...)` and `getAccessToken()` helpers. The SDK is not
  coupled to Auth or any other token issuer.
- Give `accessToken` precedence over `apiKey`, send it only in the Bearer
  header, omit cookies, and force authenticated fetch streaming for SSE.
- Keep legacy `apiKey: "uk_…"` behavior as a compatibility fallback while
  removing token-prefix inference from the recommended integration.
- Deprecate the Channel Chat-specific `client.delegatedUsers.create(...)`
  flow in favor of server-policy-controlled application-user tokens.

## 0.5.4 — 2026-08-13

- Add `client.delegatedUsers.create(...)` for trusted-backend minting of
  short-lived, subject-bound `uk_…` browser credentials.
- Add atomic `client.chat.createOrResume(...)`, plus `chat.get(...)`,
  `chat.markSeen(...)`, and recommended `chat.messages.list/send` aliases.
- Delegated fetch and SSE requests omit cookie credentials, keep bearer tokens
  in the Authorization header, and support aborting chat streams with a signal.
- Extend chat types with external-subject and conversation-key metadata while
  retaining the existing chat methods for compatibility.
- Add `client.projects.list/get` so trusted setup screens can discover project
  context instead of requiring users to copy project IDs manually.

## 0.5.3 — 2026-08-10

Adds the small chat transport primitives needed by reusable UI packages.

- `client.chat.getOrCreate(agentId, title?)` resumes the most recently updated conversation and creates one only when needed.
- Chat streams expose `onOpen`, including after native EventSource reconnects.
- API-key streams use fetch-backed SSE with the canonical bearer header, so app chat streams stay live without putting private keys in URLs.
- Chat sends and message rows support durable image attachments.
- `chat.create(agentId, { title, directive })` and `chat.update(chatId, { title, directive, archived })` expose durable per-conversation instructions.
- `chat.send(chatId, { content, clientMessageId, ... })` adds an object form while retaining the positional call for compatibility.
- `StreamFrame.phase` is typed and the documentation now correctly describes `text` as cumulative replacement text rather than a delta to append.

## 0.5.2 — 2026-07-13

Adds project-aware app routing and fuller agent administration to `client.agents`.

- `projectId` on `AptevaClientOptions` automatically adds `project_id` to app HTTP routes, MCP tool calls, and `mcpURL()`.

- `client.agents.create(input)` — POST `/api/agents`; returns either a full `Agent` or `AgentCreateWarning` when the row is created but cannot start.
- `client.agents.update(id, { name })`, `rename(id, name)`, and `delete(id)` for basic row management.
- `client.agents.config(id)` and `updateConfig(id, config)` for `/api/agents/:id/config`.
- `client.agents.systemMCP(id, "channels", enable)` for the channels system-MCP toggle.
- `client.agents.event(id, body)`, `control(id, body)`, and `events(id, handler)` for proxied core routes.
- New exported types for create/update/config/system-MCP/core-event shapes.

## 0.5.1 — 2026-05-15

**Bug fix**: `chat.stream` was silently dropping every streaming frame because the server emits them as named SSE events (`event: stream`) and the SDK only listened on the default channel.

- `client.subscribe()` gains an `eventTypes` option (default `["message"]`); registers one listener per event name.
- `client.chat.stream()` now passes `eventTypes: ["message", "stream"]` so token-delta frames actually arrive.
- Regression test guarding against silent default-event-only listeners.

If you saw the chat work but never witnessed streaming, this was why.


## 0.5.0 — 2026-05-14

Adds agent **lifecycle** control to `client.agents`.

- `client.agents.start(id)` / `stop(id)` — spawn/terminate the agent's apteva-core process; both return the updated `Agent`.
- `client.agents.restart(id)` — `{ status }`.
- `client.agents.togglePause(id)` — `{ paused }`. It's a toggle (the server has no separate resume), so check the returned state.
- New types: `AgentRestartResult`, `AgentPauseResult`.
- Example dashboard's `ChatCard` gains a Start/Stop button + live status dot, so you can bring an agent up and watch the reply stream.
- 5 new tests (77 total).


## 0.4.0 — 2026-05-14

Adds the **chat** surface — `client.chat` wraps the built-in `channel-chat` app.

- `client.chat` — `list`, `create`, `messages`, `send`, `stream`. `send` posts the user message and triggers the agent's reply in one call. `stream` discriminates the SSE feed's two frame types — full `ChatMessage` rows → `onMessage`, token-delta `StreamFrame`s → `onDelta` — so callers never touch the raw mixed stream.
- New exported types: `Chat`, `ChatMessage`, `ChatComponent`, `StreamFrame`, `ChatMessagesQuery`, `ChatStreamOptions`.
- Reference chat UI (message list, composer, streaming bubbles, optimistic send) added to `examples/dashboard/` as `ChatCard.tsx`.
- 10 new tests (72 total).

Note: `ChatMessage.components[]` (the agent's `respond(components=…)` attachments) is delivered as data; rendering app-provided components needs a loader not yet in the SDK.


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
