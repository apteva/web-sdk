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
