# @apteva/web-sdk

Browser SDK for calling [apteva-server](https://github.com/apteva/server). Framework-agnostic.

- **Auth transport** — session cookies, private API keys, and opaque application-user access tokens. The SDK does not depend on a particular token issuer.
- **App data** — `client.app("crm").get("/contacts")` reverse-proxies through `/api/apps/<name>/*`.
- **App tools** — `client.app("crm").tool("contacts_search", {…})` posts an MCP `tools/call`, unwraps the JSON-RPC envelope, returns the tool's natural shape.
- **Static-app mode** — when the UI is hosted by apteva-server itself (`runtime.kind: static`), `pickBaseURL` and `pickKioskKey` read the `<script>window.__APTEVA_APP__</script>` block the server injects.

## Install

```sh
bun add @apteva/web-sdk
# or
npm install @apteva/web-sdk
```

## Quick start

```ts
import { AptevaClient } from "@apteva/web-sdk";

const apteva = new AptevaClient({
  baseURL: "https://agents.example.com",
  // Optional. Omit to rely on an apteva-server session cookie.
});

// Sign in (sets the session cookie on the apteva-server domain).
const me = await apteva.auth.login("you@example.com", "hunter2");

// Read from any installed app's HTTP routes.
const health = await apteva.app("flexylead").get("/healthz");

// Call an MCP tool — the envelope is unwrapped for you.
type Lead = { id: number; name: string; status: string };
const { leads } = await apteva.app("flexylead").tool<{ leads: Lead[] }>(
  "leads_list",
  { limit: 25 },
);
```

## Load an installed app without its npm package

```tsx
import * as React from "react";
import { AptevaClient } from "@apteva/web-sdk";

const client = new AptevaClient({ baseURL, accessToken });
const loaded = await client.apps.load("conversations", {
  projectId, installId, react: React,
});
const Chat = loaded.components["conversation-chat"];
// In JavaScript/JSX; TypeScript hosts can supply their component/client types
// through apps.load<ClientContract, React.ComponentType<HostProps>>(...).
<Chat conversations={loaded.client} agentId={agentId} />
// After unmounting all consumers:
loaded.dispose();
```

Only the shared SDK and the host's React are installed. The selected app serves
`/ui/frontend.json`, a headless client module, a UI factory and scoped styles as
part of its regular app release. Omit `react` for headless loading. Every load
creates a new client; retain it across renders and replace it when identity or
scope changes. `clientOptions` passes app-specific options to the client factory.

The loader requires explicit project/install selection. Asset fetches use the
SDK's current authentication, with no tokens in URLs, reject redirects and verify
SHA-256 hashes before execution. Metadata is fetched fresh; client/UI/styles download in parallel and immutable
asset URLs reuse the browser cache on later visits. Code caches contain
no credentials or app client instances. `expectedVersion` can reject unexpected
app upgrades. UI factories receive the host's React (major version checked), so
no import map or separate React copy is needed. Styles are reference counted and
removed by `dispose()`. Pass `signal` to cancel a pending load.

Explicit loading executes trusted installed-app code in the host page. HTTPS or
localhost is required for integrity checks, and CSP must permit `script-src blob:`
and the loader's inline styles. It does not sandbox app code or grant API access.
No component URLs from user messages are accepted as loader entry points.

### App frontend contract

Ship `/ui/frontend.json` with schema `apteva-app-frontend/v1`, `app`, `version`,
and `client: { path, sha256 }`. The optional `ui` asset also declares `reactMajor`
and a `components` name array; `styles` is an optional CSS asset. Paths stay under
`/ui/`, contain no queries or traversal, and use lowercase SHA-256 hex hashes.
Content-addressed filenames keep an update from mixing incompatible assets.

The client module exports `createClient({ app }, options)` and the UI module
exports `createFrontend({ react })`, returning `{ components }`. Each module must
be self-contained, without external imports, relative chunks or runtime require.
The UI module should instantiate its contexts inside the factory. CSS should be
scoped to the app. See Conversations' `frontend/build-app.ts` for the implementation.

## Authentication carriers

With no bearer credential, the SDK sends `credentials: "include"` so an
apteva-server session cookie flows automatically. Private platform integrations
can provide `apiKey`. Browser applications should provide an opaque
`accessToken` issued by their trusted authentication flow.

`accessToken` takes precedence over `apiKey`. It is sent only through the
`Authorization: Bearer` header, cookie credentials are omitted, and SSE uses
authenticated `fetch()` streaming. The SDK does not inspect its prefix or know
whether Auth, another Apteva app, or a customer service issued it.

```ts
const apteva = new AptevaClient({
  baseURL: "...",
  accessToken: loginResult.apteva_access_token, // application user
  // apiKey: process.env.APTEVA_API_KEY,         // trusted backend only
  projectId: "proj_123", // routes project-scoped app HTTP and MCP calls
  onUnauthorized: () => router.push("/login"),  // fires once per 401
  timeoutMs: 30_000,    // default, 0 disables
});

// Replace an expired token without rebuilding the client.
apteva.setAccessToken(refreshed.apteva_access_token);
```

The example above deliberately leaves login outside the SDK. Auth can return
`apteva_access_token`, but the Web SDK remains decoupled and accepts any opaque
bearer token that apteva-server recognizes.

## App HTTP routes

`client.app(name)` returns a handle with `get / post / put / patch / del` that route to `/api/apps/<name>/<path>`. Same auth, same proxy, same error model.

```ts
await apteva.app("storage").post("/upload", { ... });
const file = await apteva.app("storage").get<File>("/files/42");
```

## MCP tools

`client.app(name).tool(toolName, args)` does the round-trip through `/api/apps/<name>/mcp`:

```ts
const result = await apteva.app("tables").tool<{ rows: Row[]; total: number }>(
  "rows_search",
  { table: "leads", limit: 50 },
);
```

If the MCP call returns a JSON-RPC error, the SDK throws `AptevaError(-1, message, code)` — same `catch` block as HTTP errors.

For lower-level usage, `client.callTool(appName, toolName, args)` and the standalone `unwrapMCP(envelope)` are both exported.

## App-owned extensions and web components

Apps can serve their client and components with the normal app release through
`apps.load`, or supply local modules to `client.use` and the component registry.
The core SDK has no React dependency; a host that loads React UI supplies its own
React instance. Dashboard wrappers and external hosts share component source and
an authenticated app handle. A per-app npm package is optional.

### Typed extensions

`defineAppExtension` preserves the extension's return type. `client.use` supplies
an authenticated app handle. Each call creates a new instance: retain it in your
host (for example with React's `useMemo`), and close subscriptions when unmounting.
An async `create` is supported; `use` then returns its Promise unchanged.

```ts
import { AptevaClient, defineAppExtension } from "@apteva/web-sdk";

// Illustrative app-owned API. Replace routes and wire types with your app's contract.
const itemsExtension = defineAppExtension({
  app: "example",
  create: ({ app }) => ({
    list: (signal?: AbortSignal) =>
      app.get<Array<{ id: string; title: string }>>("/items", { signal }),
  }),
});

const client = new AptevaClient({ baseURL: "https://agents.example.com", accessToken });
const items = client.use(itemsExtension, { projectId: "p1", installId: 42 });
const rows = await items.list(); // typed result
```

Extensions contain the app's own business logic and API contract validation.
A Conversations extension and its chat, inbox, and approval UI belong in the
Conversations package. The existing `client.chat` remains a Channel Chat API;
it is not redirected to Conversations.

### Shared app transport

`client.app(name, { projectId, installId })` scopes HTTP, MCP, and subscriptions
together. It exposes `name`, `projectId`, and `installId` for host context and
reads the client's current credentials on each request or reconnection.
Explicit handle scope overrides routing query parameters. With no explicit
project scope, the existing client default and query-override behavior remain.
The platform still validates the selected installation and project.

```ts
const app = client.app("example", { projectId: "p1", installId: 42 });
const controller = new AbortController();

await app.post("/items", { title: "Hello" }, { signal: controller.signal });
await app.tool("items_list", {}, { signal: controller.signal });

const subscription = app.subscribe<{ id: string; title: string }>(
  "/events",
  (row, metadata) => console.log(row, metadata.event, metadata.id),
  { signal: controller.signal, eventTypes: ["item.updated"] },
);
subscription.close();
```

All HTTP helpers accept `RequestInit`; MCP accepts it as the third argument.
Cancellation works alongside the client timeout, including while reading the
response body. App paths must start with `/` and remain inside the app route.
Use the raw client methods for platform endpoints. No HTTP method is retried
automatically. Pass an app-supported idempotency header or body field explicitly
when the app contract permits a write to be retried.

### Component exports and manifest metadata

`AppComponentReference` is the existing `{ app, name, props? }` message shape;
`ChatComponent` remains a compatible name. `AppComponentSpec` mirrors existing
`provides.ui_components` metadata, including slots, prop schemas and widget
settings. There is no second server declaration format.

`AppComponentRegistry<T>` maps those app/component names to local frontend
exports. It accepts framework-specific components or host-owned loaders without
adding a framework dependency. Registration rejects duplicate names atomically
and returns an idempotent unregister function; unknown references resolve to
`undefined` so the host can render a fallback.

```ts
import { AppComponentRegistry } from "@apteva/web-sdk";
import { ItemCard } from "./components/ItemCard"; // or an app-owned frontend package

const components = new AppComponentRegistry<typeof ItemCard>();
const unregister = components.register("example", { "item-card": ItemCard });
const Component = components.resolve({ app: "example", name: "item-card" });
// Render Component using your framework and validated, appropriate props.
unregister();
```

`AppComponentContext` defines a host-injected `app: AppHandle`. Pass this trusted
context separately from message data; do not let message props replace it.
The host handles rendering, slots, schema validation, loading/error boundaries,
theme and component lifecycle. Registry membership alone does not establish
installation, compatibility, identity or authorization. Existing dashboard
module loading remains a host concern; installing this SDK does not port an
existing component's fetch calls or styling automatically.

### Installed-app discovery and compatibility

`client.apps.list({ projectId? }, requestInit?)` wraps the existing `/api/apps`
endpoint and defaults to the client's project. This endpoint retains its current
platform permissions; application-user tokens are not guaranteed access. Hosts
can instead supply metadata they have already obtained through an authorized
flow. Extension setup does not automatically perform discovery.

```ts
import { checkAppCompatibility, assertAppCompatibility } from "@apteva/web-sdk";

const installed = (await client.apps.list()).find(app => app.install_id === 42);
const requirements = {
  app: "example",
  version: { description: "1.x", accepts: (version: string) => version.startsWith("1.") },
  tools: ["items_list"],
  components: ["item-card"],
};
const result = checkAppCompatibility(installed, requirements); // { compatible, issues }
assertAppCompatibility(installed, requirements); // AptevaError if incompatible
```

Version policy belongs to the app package: supply a predicate (including a semver
library if needed). These checks validate advertised app identity, version,
tools and components. They do not infer API schema versions, backend health,
permissions or unadvertised capabilities. App extensions should separately
validate any app-owned versioned API contract they require.

### Subscription recovery

Generic subscriptions accept `signal`; already-aborted signals open no connection.
Bearer credentials use authenticated fetch streaming. Cookie clients can opt into
fetch with `transport: "fetch"`. `lastEventId`, `cursorParam`, `deduplicate`, and
`reconnectDelayMs` also select fetch streaming, even if an EventSource was supplied.

```ts
const subscription = app.subscribe("/events", onEvent, {
  signal: controller.signal,
  lastEventId: savedEventId,
  cursorParam: "since_id", // only if this app accepts SSE IDs here
  deduplicate: true,      // only if the app promises unique IDs per event
  deduplicationWindow: 1000,
  reconnectDelayMs: 1000,
});
```

Fetch streams preserve SSE IDs across reconnects, send `Last-Event-ID`, and
optionally send the same ID in the app's cursor query parameter. Deduplication
is opt-in and bounded to the most recent 1000 delivered IDs by default; ID-less
updates are always delivered. It does not persist across new subscriptions.
Message-row IDs and SSE IDs are not interchangeable unless the backend says so.
Named events still require `eventTypes`. Malformed JSON is skipped; a throwing
fetch-stream event/open callback is reported and closes the subscription.

Reconnect delay defaults to 1000ms. Closing or aborting cancels the active reader
and any pending reconnect. Fetch streams stop on 204 or 403, and on 401 unless
credentials can be renewed once before a successful connection. Other failures
reconnect. Native EventSource retains the browser's own reconnect behavior.
The SDK cannot supply replay, a gap-free history/live handoff, or durable delivery
unless the app backend implements those contracts.

### Host-owned credential renewal

Configure `refreshAccessToken: async () => tokenOrUndefined` on the client to
reuse your own authentication flow. Concurrent 401s coordinate one in-flight
refresh. `client.refreshAccessToken()` can also be called proactively; it returns
whether a new token was applied. A login/logout/token replacement during a
refresh wins over the late result. An undefined result leaves credentials intact.

A failed HTTP request still throws its original 401 and triggers `onUnauthorized`
after the renewal attempt; it is never replayed. Subsequent calls use the new
token. Requests with a caller-supplied Authorization header do not trigger
renewal. Fetch SSE can reconnect once with renewed credentials; another 401
before a successful connection terminates the subscription. Automatic renewal
failure preserves the original 401; direct `refreshAccessToken()` calls expose
hook errors. The SDK transports opaque credentials and makes no identity or
permission decisions.

## Agents

`client.agents` wraps the core `/api/agents/*` routes — the running apteva-core child processes.

```ts
// Reads
const agents = await apteva.agents.list();              // Agent[]
const agent  = await apteva.agents.get(3);              // Agent
const status = await apteva.agents.status(3);           // AgentStatus — iteration, rate, model, paused, uptime…
const threads  = await apteva.agents.threads(3);        // Thread[]
const channels = await apteva.agents.channels(3);       // ChannelInfo[]
const history  = await apteva.agents.chatHistory(3, 50); // ChatHistoryMessage[]

// Management
await apteva.agents.create({
  name: "Support",
  directive: "Answer customer questions.",
  mode: "cautious",
  project_id: "proj_123",
});
await apteva.agents.rename(3, "Support v2");
await apteva.agents.update(3, { name: "Support v3" });
await apteva.agents.delete(3);      // → { status: "deleted" }

// Config and system MCPs
const config = await apteva.agents.config(3);
await apteva.agents.updateConfig(3, { ...config, mode: "learn" });
await apteva.agents.systemMCP(3, "channels", true);

// Lifecycle
await apteva.agents.start(3);        // spawn the process → updated Agent
await apteva.agents.stop(3);         // terminate          → updated Agent
await apteva.agents.restart(3);      // → { status: "restarted" }
await apteva.agents.togglePause(3);  // → { paused: boolean } — toggle, not a setter

// Proxied core routes
await apteva.agents.event(3, { message: "Summarize recent activity" });
await apteva.agents.control(3, { action: "wake" });
const events = apteva.agents.events(3, (event) => console.log(event.type));
```

`togglePause` is a *toggle* (the server has no separate resume endpoint) — check the returned `.paused` rather than assuming the new state.

## Activity / telemetry

`client.telemetry` wraps `/api/telemetry*` — reads plus a live SSE feed.

```ts
// Filtered event read
const events = await apteva.telemetry.query({
  agentId: 3, type: "tool.call", limit: 100,
});

// Aggregates
const timeline = await apteva.telemetry.timeline(3, "24h"); // TimelineBucket[]
const stats    = await apteva.telemetry.stats(3, "24h");    // TelemetryStats

// Live feed — returns a handle, call .close() to stop
const sub = apteva.telemetry.stream(3, (event) => {
  console.log(event.type, event.data);
});
// later…
sub.close();
```

`telemetry.stream` normalizes a server quirk where `event.data` occasionally arrives as a JSON-stringified string instead of an object.

For any other SSE endpoint, `client.subscribe(path, params, onEvent, opts?)` is the generic form `telemetry.stream` is built on.

With an API key or access token, `subscribe`/`stream` use authenticated fetch
streaming and send the credential in the `Authorization` header. Access tokens
are never placed in query strings. Cookie-authenticated clients use native
`EventSource`; in runtimes without it, pass a polyfill via `opts.EventSource`.

## Chat

`client.chat` wraps the built-in `channel-chat` app — one chat is bound to one agent, and the agent's reply streams back token-by-token.

```ts
// Pick an agent and create a durable, independently instructed conversation.
const [agent] = await apteva.agents.list();
const chat = await apteva.chat.create(agent.id, {
  title: "Website support",
  directive: "Help this visitor choose the right subscription plan.",
});
const history = await apteva.chat.messages(chat.id, { limit: 200 });

// Live feed — the SSE stream interleaves full message rows and token
// deltas; the SDK discriminates them for you.
const sub = apteva.chat.stream(chat.id, {
  since: history.at(-1)?.id ?? 0,
  onMessage: (m) => { /* full ChatMessage row — user | agent | system */ },
  onDelta:   (d) => { /* StreamFrame: replace this call_id's bubble with d.text */ },
});

// Update only this conversation's instructions. Empty string clears them.
await apteva.chat.update(chat.id, {
  directive: "Focus on annual business plans.",
});

// Send — use a stable clientMessageId when retrying the same turn.
await apteva.chat.send(chat.id, {
  content: "Which plan is best for a team of 20?",
  clientMessageId: crypto.randomUUID(),
});

// Images use the same durable chat path and may be sent with or without text.
await apteva.chat.send(chat.id, "What is shown here?", {
  attachments: [{
    type: "image",
    data_url: "data:image/png;base64,...",
    name: "screenshot.png",
    mime_type: "image/png",
    size: 12345,
  }],
});

sub.close();
```

`chat.send` returns the persisted user message, so you can swap an optimistic bubble for the real row.

Always address Channel Chat with `chat.id`. `thread_id` is informational and must not be used for message delivery. `instance_id` is a legacy response alias; new code should use `agent_id`.

For a logged-in website user who is not an Apteva platform account, initialize
the SDK with the application-user token returned by the site's authentication
flow:

```ts
// `login` belongs to the website/Auth integration, not @apteva/web-sdk.
const login = await websiteAuth.login(email, password);
if (!login.apteva_access_token) {
  throw new Error("No Apteva access policy is configured for this client");
}

const browserClient = new AptevaClient({
  baseURL: "https://agents.example.com",
  accessToken: login.apteva_access_token,
});
const chat = await browserClient.chat.createOrResume(4, {
  title: "Customer support",
  conversationKey: "support",
});
const history = await browserClient.chat.messages.list(chat.id);
await browserClient.chat.messages.send(chat.id, {
  content: "Which plan is right for 20 people?",
  clientMessageId: crypto.randomUUID(),
});
const lastMessage = history.at(-1);
if (lastMessage) await browserClient.chat.markSeen(chat.id, lastMessage.id);
```

The browser never submits `subject_id`, `project_id`, scopes, or a directive
when it creates the conversation. Trusted identity comes from the credential;
server policy selects permitted apps, actions, and agent IDs; Channel Chat
enforces its chat-specific resources. Reusing the same subject, project, agent,
and `conversationKey` atomically resumes the same conversation.

`client.delegatedUsers.create(...)` remains available for older trusted-backend
integrations, but is deprecated and is no longer the recommended website flow.

**Rendering note:** `ChatMessage.components[]` carries the agent's `respond(components=…)` attachments. Use `AppComponentRegistry` to resolve these references against app-owned frontend exports, then render them in your host framework. Use `apps.load` to explicitly load a trusted installed app’s frontend before registering its components.

A complete reference chat UI (message list, composer, streaming bubbles, optimistic send) lives in [`examples/dashboard/src/components/ChatCard.tsx`](./examples/dashboard/src/components/ChatCard.tsx).

## Error handling

Every non-2xx response and every MCP error throws an `AptevaError`:

```ts
try {
  await apteva.app("crm").tool("contacts_get", { id: 999 });
} catch (err) {
  if (err instanceof AptevaError) {
    if (err.isUnauthorized()) ...      // 401
    if (err.isNotFound()) ...          // 404
    if (err.status === -1) ...         // MCP-level error
    console.error(err.body);
  }
}
```

Network failures (no DNS, refused connection) surface as `AptevaError(0, "...")`. Timeouts surface as `AptevaError(0, "request timeout after Xms")`.

## Hosted on apteva-server itself

If your UI is installed as a `runtime.kind: static` app, apteva-server injects a config block. The SDK picks it up:

```ts
import { AptevaClient, pickBaseURL, pickKioskKey } from "@apteva/web-sdk";

const apteva = new AptevaClient({
  baseURL: pickBaseURL(),     // window.__APTEVA_APP__.api_base
  apiKey:  pickKioskKey(),    // ?api_key=... > install config > undefined
});
```

The same code also works fine when hosted externally (Vercel, etc.) — `pickBaseURL` returns `""` (same-origin) when nothing is injected, and `pickKioskKey` returns `undefined` (fall back to cookie auth).

## SSE transports

Prefer `client.subscribe()` and the typed stream helpers. They select
authenticated fetch streaming for API keys and access tokens, and credentialed
native `EventSource` for cookie sessions. Access tokens never enter the URL.

`sseURL()` remains available for endpoints that explicitly accept an API key in the query string, or for external clients that must construct their own `EventSource`:

```ts
const url = apteva.sseURL("/api/events", { project_id: "abc" });
// → https://agents.example.com/api/events?project_id=abc&api_key=sk-...
new EventSource(url);
```

Not every server SSE route accepts query-string credentials, so do not use `sseURL()` as a replacement for `client.subscribe()` unless the endpoint documents that carrier.

## TypeScript

Ships `.d.ts` types. `client.app<DefaultShape>(name).get<R>(path)` lets you type either per-call or per-app.

## Example

A complete React 19 + Tailwind v4 dashboard that signs in, reads leads from the Tables app, and browses arbitrary tables lives in [`examples/dashboard/`](./examples/dashboard) in the repo. Run with:

```sh
cd examples/dashboard
bun install
API_BASE=http://localhost:5280 bun run build
bun run serve
```

## License

MIT

## One client for Auth app sessions (v0.9.0)

With Auth app v0.12.0 or newer, configure `auth` and use the same client for
login, app requests, agents and logout:

```ts
const apteva = new AptevaClient({
  baseURL: "https://agents.example.com",
  projectId: "YOUR_PROJECT",
  auth: {
    clientId: "YOUR_PUBLIC_AUTH_CLIENT",
    // installId: 209,              // when explicit install routing is needed
    // organizationSlug: "default",// for a multi-organization Auth client
    // profile: "commercial",      // requested role policy; checked by Auth
    onSessionChange: session => renderUser(session?.user),
  },
});

const user = await apteva.auth.login({ email, password });
const crm = apteva.app("api", { credential: "auth" });
const conversations = apteva.app("conversations", { credential: "platform" });
await crm.get("/YOUR_CRM_ROUTE");
await conversations.get("/chats");

const telephony = await apteva.apps.load("telephony", {
  credential: "auth",
  installId: YOUR_TELEPHONY_INSTALL_ID,
  clientOptions: { authProvider: "YOUR_CONFIGURED_PROVIDER" },
});
// The loaded client keeps this Auth handle for /user/ calls and subscriptions.
await apteva.auth.logout();
```

`auth.register({ email, password, displayName? })` also supports signup. When
email verification is required, it returns `verification_required: true` and
does not establish a session. `auth.me()` reads the current Auth user;
`auth.getSession()` returns a local copy of user, authorization and expiry
metadata without credentials. `auth.status()` reports local session presence.
`auth.refresh()` explicitly requests a fresh platform credential when needed.

Auth owns identity and authorization. Configure its trusted role bindings and
matching platform policies with `token_ttl_seconds: 60` before enabling platform
app access. Login can succeed without platform permissions; platform calls fail
closed until an authorized policy can mint a token. Auth-credential routes remain
available according to their own current user permissions. A requested profile never grants a
role. The SDK does not infer permissions or mint credentials itself.

The SDK privately maintains the normal Auth session plus its short-lived
platform token. Choose `credential: "auth"` for API Auth-policy routes and
Telephony `/user/` routes; choose `"platform"` for Conversations. Omitted choices
default to `"platform"`. The choice applies to every HTTP method, MCP tool and
subscription on that handle, and to `client.use` and `client.apps.load`. Loaded
frontend assets and the resulting app client share the selected handle.

Before a request, the SDK renews the selected credential when it is within ten
seconds of expiry. Auth tokens use the normal Auth refresh flow; platform tokens
use `/delegated-token`. Auth requests do not require a working mint policy. Concurrent operations share renewal and refresh-token rotation; no custom
refresh callback or application token endpoint is required. Both the returned
absolute expiry and remaining lifetime limit credential use. Fetch streams
reconnect at token expiry and close on local logout. SDK stream reconnection is
not server-side revocation: already-admitted work or a modified client may outlive
token expiry unless the receiving app enforces its own lifetime.

Sessions default to **memory-only**. Reuse one client per application session.
Reloads/new tabs require login unless the host explicitly enables persistent
sessions as described below. Do not manage or copy refresh credentials yourself.

`auth` mode cannot be combined with `apiKey`, `accessToken` or
`refreshAccessToken`; `setApiKey` and `setAccessToken` are unavailable in this
mode. `getAccessToken()` now returns `undefined` in managed mode: use scoped
handles instead of extracting either credential. Host-owned opaque tokens retain
the existing getter behavior. Auth handles cannot change the configured project
or escape their app routes; credentials are never forwarded through redirects
or accepted from URL parameters or header overrides.

User requests omit cookies and never fall back to a kiosk or administrator
credential. Platform administrator operations such as `auth.listKeys()` are
rejected in app Auth mode. Without `auth` configuration, existing platform
login and opaque-token APIs retain their original behavior.

A temporary mint failure preserves the normal Auth session and blocks only
platform-credential requests. Credential types never switch after an error. A rejected Auth refresh clears the session. Local logout clears
credentials and streams immediately; a failed network logout still throws so the
host can report that server-side revocation could not be confirmed. A late
renewal cannot restore a logged-out session. HTTP writes are never automatically
replayed after a 401; successful renewal prepares subsequent calls. Unlike legacy
transport mode, a successfully recovered 401 does not trigger the
`onUnauthorized` callback in managed Auth mode, although the original call still
rejects. Reconcile a write's outcome before retrying it.


### Mixed-app integration check

Run `APTEVA_APPS_DIR=/path/to/apps bun run test:mixed-apps` with a compatible Go
compiler (`GO_BINARY` can select it). This uses real Auth handlers, API's
`auth_jwt` validator and Telephony's `/user/` handler, temporary databases and
local fixture servers. The platform mint API and protected Conversations gateway
are simulated. It verifies routing, role downgrade, and server-side session
revocation without accessing live accounts or carriers. Set `SDK_TEST_MODULE` to
an unpacked package's `dist/index.js` to check the release artifact.


## Optional persistent Auth sessions

Persistence is application-independent and opt-in. It uses the same managed Auth
session as HTTP, MCP, frontend loaders and streams; app credential selection does
not change. No customer-specific storage key, legacy session format or routing is
built into the SDK.

```ts
const client = new AptevaClient({
  baseURL,
  projectId,
  auth: {
    clientId,
    persistence: "local", // default: "memory"
    onStateChange: state => renderSessionState(state),
    onSessionChange: session => renderUser(session?.user),
  },
});

try {
  await client.auth.restore();
} catch {
  // Show a retry action or login, according to client.auth.getState().
}

const crm = client.app("api", { credential: "auth" });
const conversations = client.app("conversations", { credential: "platform" });
```

`auth.getState()` reports `status` (`idle`, `restoring`, `authenticated`,
`unauthenticated`, or `error`), effective `persistence` (`memory`, `local`, or
`unavailable`) and optional credential-free error metadata. Render loading for
`idle`/`restoring`, rather than briefly displaying the login screen. Concurrent
`restore()` calls share one promise. Protected requests await pending restoration
and can start initial restoration themselves. After a restoration error, retry
explicitly with `restore()` or log in; requests do not repeatedly retry it.

Only the refresh credential, format version, configuration scope and locally
generated session/revision identifiers are persisted in localStorage. Normal Auth
and platform access tokens, user details and permissions stay in memory. The
`/refresh` response supplies the authoritative user and authorization context.
`getSession()`, `getState()`, callbacks and cross-tab notifications expose no
credentials. Browser storage is JavaScript-readable: enabling it deliberately
accepts the same-origin script/XSS exposure of a persisted refresh credential.

Storage and lock namespaces include the canonical server URL, project, Auth
installation (or automatic routing), organization, public client and profile.
Use consistent configuration across tabs that should share a session. Cross-tab
sharing is limited to the same browser origin and storage partition. Different
scopes do not import each other's credentials or identities.

Native Web Locks serialize login, restore, refresh and logout. Each refresh reads
the latest saved credential under the lock, writes an in-progress marker before
sending it, then saves the replacement before releasing the lock. Other tabs are
notified without broadcasting credentials. Switching accounts invalidates the
previous local session and closes its streams. Disposed clients release browser
listeners and local streams through `client.auth.dispose()` without revoking or
deleting the saved session.

If localStorage or Web Locks are unavailable, `persistence` reports `unavailable`
and a fresh login works in memory-only mode. There is no localStorage-based lock
fallback. If saving a rotated credential fails, the replacement remains in memory
and the durable in-progress marker prevents other tabs from reusing the old one.
A failure reading previously shared credentials requires a new login; the SDK
cannot safely promote a potentially stale in-memory refresh to an independent
session.

Logout clears local credentials and streams immediately. It then clears the
saved refresh credential under the shared lock, notifies other tabs, and asks
Auth to revoke the session. A failed network logout still rejects: local logout
does not guarantee server-side revocation while offline. Late refresh results
cannot replace a newer login or resurrect a completed logout.

Restoration failure handling:

| Result | SDK behavior |
| --- | --- |
| Auth rejects an invalid/revoked refresh with 401 | Clear the saved and local session; login is required. |
| Browser is already offline before sending | Preserve the saved credential; retry restoration when connected. |
| Auth returns `refresh_unavailable` with 503 | Auth confirms rotation did not commit; preserve the credential for explicit retry. |
| Network failure, generic proxy 5xx, malformed response, or `refresh_uncertain` | Preserve an uncertain marker; do not reuse the old credential. If no replacement was saved, require login. |
| Platform mint denied | Restore the Auth session; platform-protected access remains blocked. |
| Unsupported or malformed storage format | Fail closed; login or logout replaces the record. |

The explicit retry-safe and uncertain response codes require the accompanying
Auth refresh-error classification fix. With older Auth versions, generic errors
are handled conservatively. A tab crash after server rotation but before saving
the response cannot be recovered transparently with single-use refresh tokens.

There is no automatic legacy-session migration. Existing customer storage is not
read or deleted; hosts should remove their old refresh loops and require one
login when adopting persistence. Any future import must be a separate explicit,
tested SDK API. HTTP writes are never replayed automatically after a 401.

Validate native browser behavior with `bunx playwright install chromium` followed
by `bun run test:persistence:browser`. These checks use isolated local fixtures,
real tabs, Web Locks and localStorage; they do not contact customer accounts.
