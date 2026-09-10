import { test, expect } from "bun:test";
import { AptevaClient, type StreamHandle } from "../src";

const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await delay();
  expect(check()).toBe(true);
}
function fixture() {
  let authVersion = 0, platformVersion = 0, refreshes = 0, mints = 0, revoked = false;
  let authLife = 900, platformLife = 60, unavailable = false, reject = false;
  let mintBarrier: Promise<void> | undefined, requestBarrier: Promise<void> | undefined;
  let cancelled = 0;
  const requests: { path: string; token: string | null; method?: string }[] = [];
  const platform = () => ({ apteva_access_token: `platform-${platformVersion}`, apteva_expires_in: platformLife,
    apteva_expires_at: new Date(Date.now() + platformLife * 1000).toISOString() });
  const session = () => ({ user: { id: 1 }, access_token: `auth-${authVersion}`, refresh_token: `refresh-${authVersion}`,
    expires_in: authLife, ...(!unavailable ? platform() : {}) });
  const source = 'export function createClient({app},options){return {calls:()=>app.get("/user/calls?auth_provider="+options.authProvider),stream:cb=>app.subscribe("/user/events?auth_provider="+options.authProvider,cb)}}';
  const fetchImpl = (async (input, init) => {
    const url = new URL(String(input)), path = url.pathname;
    const token = new Headers(init?.headers).get("Authorization");
    requests.push({ path, token, method: init?.method });
    expect(url.origin).toBe("https://server.example");
    expect(url.searchParams.get("project_id")).toBe("p");
    expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
    if (path === "/api/apps/auth/login") { revoked = false; return Response.json(session()); }
    if (path === "/api/apps/auth/logout") { revoked = true; return new Response(null, { status: 204 }); }
    if (path === "/api/apps/auth/refresh") {
      refreshes++;
      if (revoked) return new Response("revoked", { status: 401 });
      expect(JSON.parse(String(init?.body)).refresh_token).toBe(`refresh-${authVersion}`);
      await delay(); authVersion++; platformVersion++;
      return Response.json(session());
    }
    if (path === "/api/apps/auth/delegated-token") {
      mints++; const result = platform();
      if (mintBarrier) await mintBarrier;
      if (revoked) return new Response("revoked", { status: 401 });
      if (unavailable) return new Response("policy unavailable", { status: 403 });
      return Response.json(result);
    }
    const expected = path.startsWith("/api/apps/conversations/") ? `Bearer platform-${platformVersion}` : `Bearer auth-${authVersion}`;
    if (requestBarrier) await requestBarrier;
    if (revoked || reject || token !== expected) return new Response("wrong or revoked credential", { status: 401 });
    if (path.endsWith("frontend.json")) return Response.json({ schema: "apteva-app-frontend/v1", app: "telephony", version: "1.0.0",
      client: { path: "/ui/client.mjs", sha256: new Bun.CryptoHasher("sha256").update(source).digest("hex") } });
    if (path.endsWith("client.mjs")) return new Response(source);
    if (path.endsWith("events")) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
      init!.signal!.addEventListener("abort", () => { cancelled++; controller.error(new Error("closed")); });
    } }), { headers: { "Content-Type": "text/event-stream" } });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const client = new AptevaClient({ baseURL: "https://server.example", projectId: "p", auth: { clientId: "c" }, fetch: fetchImpl });
  return { client, requests, crm: client.app("api", { credential: "auth" }), conversations: client.app("conversations"),
    phone: client.app("telephony", { credential: "auth" }), login: () => client.auth.login({ email: "e", password: "p" }),
    counts: () => ({ refreshes, mints, cancelled }), expireAuth: () => { authLife = 1; }, expirePlatform: () => { platformLife = 1; },
    healthy: () => { authLife = 900; platformLife = 60; }, unavailable: () => { unavailable = true; }, revoke: () => { revoked = true; },
    reject: (value = true) => { reject = value; }, holdMint: (value: Promise<void>) => { mintBarrier = value; },
    holdRequests: (value: Promise<void>) => { requestBarrier = value; } };
}

test("one session selects credentials for API, Conversations, Telephony and extensions", async () => {
  const f = fixture(); await f.login();
  await Promise.all([f.crm.get("/crm"), f.conversations.get("/chats"), f.phone.get("/user/calls?auth_provider=login")]);
  const extension = f.client.use({ app: "api", create: ({ app }) => app }, { credential: "auth" });
  await extension.post("/crm", {});
  expect(f.requests.slice(1).map(r => r.token).sort()).toEqual(["Bearer auth-0", "Bearer auth-0", "Bearer auth-0", "Bearer platform-0"]);
  expect(f.client.getAccessToken()).toBeUndefined();
  expect(JSON.stringify(f.client.auth.getSession())).not.toContain("auth-0");
});

test("Auth routes remain usable without a platform policy, including refresh", async () => {
  const f = fixture(); f.unavailable(); f.expireAuth(); await f.login(); f.healthy();
  await Promise.all([f.crm.get("/crm"), f.phone.get("/user/calls")]);
  expect(f.counts()).toMatchObject({ refreshes: 1, mints: 0 });
  await expect(f.conversations.get("/chats")).rejects.toThrow("403");
  await f.crm.get("/crm");
});

test("concurrent expiry across both credentials shares one Auth refresh", async () => {
  const f = fixture(); f.expireAuth(); f.expirePlatform(); await f.login(); f.healthy();
  await Promise.all(Array.from({ length: 20 }, () => Promise.all([f.crm.get("/crm"), f.conversations.get("/chats"), f.phone.get("/user/calls")])));
  expect(f.counts()).toMatchObject({ refreshes: 1, mints: 0 });
});

test("concurrent Auth 401s refresh once, preserve the error and never replay writes", async () => {
  const f = fixture(); await f.login(); f.reject();
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => f.crm.post("/crm", {})));
  for (const result of results) { expect(result.status).toBe("rejected"); if (result.status === "rejected") expect(result.reason.status).toBe(401); }
  expect(f.counts()).toMatchObject({ refreshes: 1, mints: 0 });
  expect(f.requests.filter(r => r.path === "/api/apps/api/crm")).toHaveLength(20);
  f.reject(false); await f.crm.get("/crm"); expect(f.requests.at(-1)?.token).toBe("Bearer auth-1");
});

test("late platform mint cannot overwrite a newer Auth refresh", async () => {
  const f = fixture(); await f.login();
  let release!: () => void; f.holdMint(new Promise(resolve => { release = resolve; }));
  const mint = f.client.auth.refresh(); await until(() => f.counts().mints === 1);
  f.reject(); await expect(f.crm.get("/crm")).rejects.toThrow("401"); f.reject(false);
  release(); await mint; await f.conversations.get("/chats");
  expect(f.requests.at(-1)?.token).toBe("Bearer platform-1");
});

test("late 401 from the old login cannot refresh a new login", async () => {
  const f = fixture(); await f.login(); f.reject(); let release!: () => void;
  f.holdRequests(new Promise(resolve => { release = resolve; }));
  const old = f.crm.post("/crm", {}); await until(() => f.requests.some(r => r.path.endsWith("/crm")));
  await f.client.auth.logout(); await f.login(); release();
  await expect(old).rejects.toThrow("401"); expect(f.counts().refreshes).toBe(0);
});

test("managed credentials reject forwarding escapes and overrides", async () => {
  const f = fixture(); await f.login(); const before = f.requests.length;
  for (const path of ["//evil.test/x", "/../other/x", "/%2e%2e/other/x", "/%252e%252e/x", "/x%2fy", "/x\\..\\..\\other", "/crm?project_id=other"]) {
    expect(() => f.crm.get(path)).toThrow();
  }
  await expect(f.crm.get("/crm?access_token=x")).rejects.toThrow();
  await expect(f.crm.get("/crm", { headers: { Authorization: "Bearer override" } })).rejects.toThrow();
  expect(() => f.client.app("api", { projectId: "other", credential: "auth" })).toThrow();
  expect(() => f.client.app("api", { credential: "invalid" as any })).toThrow();
  expect(() => new AptevaClient({ baseURL: "" }).app("api", { credential: "auth" })).toThrow();
  expect(f.requests).toHaveLength(before);
});

test("Telephony frontend retains credential choice for assets, calls and streams; logout closes both streams", async () => {
  const f = fixture(); await f.login();
  const loaded = await f.client.apps.load<{ calls(): Promise<unknown>; stream(cb: () => void): StreamHandle }>("telephony", {
    credential: "auth", installId: 42, clientOptions: { authProvider: "login" } });
  await loaded.client.calls(); let events = 0;
  const streams = [loaded.client.stream(() => { events++; }), f.conversations.subscribe("/events", () => { events++; })];
  try {
    await until(() => events === 2); await f.client.auth.logout();
    expect(f.counts().cancelled).toBe(2); const before = f.requests.length; await delay(30);
    expect(f.requests).toHaveLength(before);
    for (const request of f.requests.filter(r => r.path.startsWith("/api/apps/telephony/"))) expect(request.token).toBe("Bearer auth-0");
  } finally { streams.forEach(s => s.close()); loaded.dispose(); }
});

test("revocation discovered through Auth clears both credentials and streams", async () => {
  const f = fixture(); await f.login(); let events = 0;
  const streams = [f.phone.subscribe("/user/events", () => { events++; }), f.conversations.subscribe("/events", () => { events++; })];
  try {
    await until(() => events === 2); f.revoke(); await expect(f.crm.get("/crm")).rejects.toThrow("401");
    expect(f.client.auth.getSession()).toBeUndefined(); expect(f.counts().cancelled).toBe(2);
    const before = f.requests.length; await expect(f.conversations.get("/chats")).rejects.toThrow("Login required");
    expect(f.requests).toHaveLength(before);
  } finally { streams.forEach(s => s.close()); }
});

test("Auth streams reconnect with refreshed Auth, independent of platform expiry", async () => {
  const f = fixture(); f.expireAuth(); f.unavailable(); await f.login(); let events = 0;
  const stream = f.phone.subscribe("/user/events", () => { events++; }, { reconnectDelayMs: 1 });
  try {
    await until(() => events >= 2); expect(f.counts().refreshes).toBeGreaterThanOrEqual(2); expect(f.counts().mints).toBe(0);
  } finally { stream.close(); }
});

test("every HTTP verb and MCP tool retains the Auth credential", async () => {
  const f = fixture(); await f.login();
  await f.crm.post("/crm", {}); await f.crm.put("/crm", {}); await f.crm.patch("/crm", {}); await f.crm.del("/crm");
  await f.crm.tool("read", {});
  expect(f.requests.slice(1).map(r => r.method)).toEqual(["POST", "PUT", "PATCH", "DELETE", "POST"]);
  for (const request of f.requests.slice(1)) expect(request.token).toBe("Bearer auth-0");
  expect(f.counts().mints).toBe(0);
});

test("concurrent mixed 401s coordinate refresh without fallback or write replay", async () => {
  const f = fixture(); await f.login(); f.reject();
  const results = await Promise.allSettled(Array.from({ length: 15 }, () => [f.crm.post("/crm", {}), f.conversations.post("/chats", {})]).flat());
  expect(results.every(r => r.status === "rejected" && r.reason.status === 401)).toBe(true);
  expect(f.counts().refreshes).toBe(1); expect(f.counts().mints).toBeLessThanOrEqual(1);
  const writes = f.requests.filter(r => r.path === "/api/apps/api/crm" || r.path === "/api/apps/conversations/chats");
  expect(writes).toHaveLength(30);
  for (const r of writes) expect(r.token).toBe(r.path.includes("/conversations/") ? "Bearer platform-0" : "Bearer auth-0");
});

test("Auth stream rejection renews once then closes without changing credential type", async () => {
  const f = fixture(); await f.login(); f.reject(); let errors = 0;
  const stream = f.phone.subscribe("/user/events", () => {}, { reconnectDelayMs: 1, onError: () => { errors++; } });
  try {
    await until(() => errors === 2); const before = f.requests.length; await delay(30);
    expect(f.requests).toHaveLength(before); expect(f.counts()).toMatchObject({ refreshes: 1, mints: 0 });
    expect(f.requests.filter(r => r.path.endsWith("/events")).map(r => r.token)).toEqual(["Bearer auth-0", "Bearer auth-1"]);
  } finally { stream.close(); }
});

test("actual HTTP redirects never forward either managed credential", async () => {
  let leaked = 0;
  const sink = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { leaked++; return Response.json({}); } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    if (new URL(request.url).pathname.endsWith("/login")) return Response.json({ user: { id: 1 }, access_token: "private-auth", refresh_token: "private-refresh", expires_in: 900,
      apteva_access_token: "private-platform", apteva_expires_in: 60, apteva_expires_at: new Date(Date.now() + 60000).toISOString() });
    return Response.redirect(sink.url, 302);
  } });
  try {
    const client = new AptevaClient({ baseURL: server.url.origin, projectId: "p", auth: { clientId: "c" } });
    await client.auth.login({ email: "e", password: "p" });
    await expect(client.app("api", { credential: "auth" }).get("/redirect")).rejects.toThrow();
    await expect(client.app("conversations").get("/redirect")).rejects.toThrow();
    expect(leaked).toBe(0);
  } finally { server.stop(true); sink.stop(true); }
});
