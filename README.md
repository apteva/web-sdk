# @apteva/web-sdk

Browser SDK for calling [apteva-server](https://github.com/apteva/server). Framework-agnostic. ~3 KB minified + gzipped.

- **Auth** — session cookies, `Authorization: Bearer`, `X-API-Key`, `?api_key=` query — pick any, the SDK handles them.
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
  // Optional. Omit to rely on the session cookie (after auth.login).
  apiKey: process.env.NEXT_PUBLIC_APTEVA_KEY,
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

## Auth carriers

The SDK sends `credentials: "include"` on every request, so a session cookie set by `auth.login` flows automatically — same-origin always, cross-origin when the apteva-server's `CORS_ORIGIN` allowlists your domain (the default `permissive` mode echoes any origin).

You can layer on an API key by setting `apiKey` in the constructor or calling `client.setApiKey(...)` at runtime. Bearer-wins-over-cookie on the wire.

```ts
const apteva = new AptevaClient({
  baseURL: "...",
  apiKey: "sk-...",     // optional
  onUnauthorized: () => router.push("/login"),  // fires once per 401
  timeoutMs: 30_000,    // default, 0 disables
});
```

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

// Lifecycle
await apteva.agents.start(3);        // spawn the process → updated Agent
await apteva.agents.stop(3);         // terminate          → updated Agent
await apteva.agents.restart(3);      // → { status: "restarted" }
await apteva.agents.togglePause(3);  // → { paused: boolean } — toggle, not a setter
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

**Node note:** `subscribe`/`stream` need a global `EventSource` (browsers, Deno, Bun, Node 22+). On older Node, pass a polyfill via `opts.EventSource`.

## Chat

`client.chat` wraps the built-in `channel-chat` app — one chat is bound to one agent, and the agent's reply streams back token-by-token.

```ts
// Pick an agent, get/create its chat, load history
const [agent] = await apteva.agents.list();
const chat = await apteva.chat.create(agent.id);
const history = await apteva.chat.messages(chat.id, { limit: 200 });

// Live feed — the SSE stream interleaves full message rows and token
// deltas; the SDK discriminates them for you.
const sub = apteva.chat.stream(chat.id, {
  since: history.at(-1)?.id ?? 0,
  onMessage: (m) => { /* full ChatMessage row — user | agent | system */ },
  onDelta:   (d) => { /* StreamFrame: append d.text until d.done */ },
});

// Send — posts the user message AND triggers the agent's reply
await apteva.chat.send(chat.id, "what's the status of order 4821?");

sub.close();
```

`chat.send` returns the persisted user message, so you can swap an optimistic bubble for the real row.

**Rendering note:** `ChatMessage.components[]` carries the agent's `respond(components=…)` attachments. The SDK hands you the data, but rendering app-provided UI components needs a dynamic-component loader the SDK doesn't include yet — third-party UIs render text + a placeholder for now.

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

## SSE / EventSource

Browsers can't set headers on `EventSource`, so an API key has to ride as `?api_key=`. The SDK has a helper:

```ts
const url = apteva.sseURL("/api/events", { project_id: "abc" });
// → https://agents.example.com/api/events?project_id=abc&api_key=sk-...
new EventSource(url);
```

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
