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
import { ApteveClient } from "@apteva/web-sdk";

const apteva = new ApteveClient({
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
const apteva = new ApteveClient({
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

If the MCP call returns a JSON-RPC error, the SDK throws `ApteveError(-1, message, code)` — same `catch` block as HTTP errors.

For lower-level usage, `client.callTool(appName, toolName, args)` and the standalone `unwrapMCP(envelope)` are both exported.

## Error handling

Every non-2xx response and every MCP error throws an `ApteveError`:

```ts
try {
  await apteva.app("crm").tool("contacts_get", { id: 999 });
} catch (err) {
  if (err instanceof ApteveError) {
    if (err.isUnauthorized()) ...      // 401
    if (err.isNotFound()) ...          // 404
    if (err.status === -1) ...         // MCP-level error
    console.error(err.body);
  }
}
```

Network failures (no DNS, refused connection) surface as `ApteveError(0, "...")`. Timeouts surface as `ApteveError(0, "request timeout after Xms")`.

## Hosted on apteva-server itself

If your UI is installed as a `runtime.kind: static` app, apteva-server injects a config block. The SDK picks it up:

```ts
import { ApteveClient, pickBaseURL, pickKioskKey } from "@apteva/web-sdk";

const apteva = new ApteveClient({
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
