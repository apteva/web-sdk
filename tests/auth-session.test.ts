import { describe, expect, test } from "bun:test";
import { AptevaClient } from "../src";

const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  let refreshes = 0, renewals = 0, writes = 0, revoked = false, platformStatus = 200;
  let lifetime = 60, authLifetime = 900, mintFailure = false;
  let hold: (() => Promise<void>) | undefined;
  const requests: { path: string; token: string | null; body: any; credentials?: RequestCredentials }[] = [];
  const platform = () => ({ apteva_access_token: `platform-${renewals}`, apteva_expires_in: lifetime,
    apteva_expires_at: new Date(Date.now() + lifetime * 1000).toISOString() });
  const session = () => ({ user: { id: 42, email: "user@example.com" }, access_token: `auth-${refreshes}`, refresh_token: `refresh-${refreshes}`,
    authorization: { roles: ["commercial"], permissions: ["assistant:use"], authorization_version: 1 },
    expires_in: authLifetime, ...(!mintFailure ? platform() : {}) });
  const fetchImpl = (async (input, init) => {
    const url = new URL(String(input)); const path = url.pathname;
    const token = new Headers(init?.headers).get("Authorization");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, token, body, credentials: init?.credentials });
    if (path.startsWith("/api/apps/auth/")) {
      expect(url.searchParams.get("project_id")).toBe("project-1");
      expect(url.searchParams.get("install_id")).toBe("209");
      expect(url.searchParams.get("delegated_profile")).toBe("commercial");
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
    }
    if (path.endsWith("/login")) { revoked = false; return Response.json(session()); }
    if (path.endsWith("/signup")) return Response.json(session());
    if (path.endsWith("/logout")) { revoked = true; return new Response(null, { status: 204 }); }
    if (path.endsWith("/refresh")) {
      if (revoked || body.refresh_token !== `refresh-${refreshes}`) return new Response("invalid_grant", { status: 401 });
      refreshes++; await delay(); return Response.json(session());
    }
    if (path.endsWith("/delegated-token")) {
      renewals++; if (hold) await hold();
      if (revoked) return new Response("revoked", { status: 401 });
      if (mintFailure) return new Response("unavailable", { status: 503 });
      expect(token).toBe(`Bearer auth-${refreshes}`); return Response.json(platform());
    }
    if (path.endsWith("/me")) {
      if (revoked) return new Response("revoked", { status: 401 });
      return Response.json({ user: { id: 42 }, authorization: session().authorization });
    }
    if (init?.method === "POST") writes++;
    expect(token?.startsWith("Bearer platform-")).toBe(true);
    expect(init?.credentials).toBe("omit");
    return Response.json({ ok: true }, { status: platformStatus });
  }) as typeof fetch;
  const client = new AptevaClient({ baseURL: "https://platform.example", projectId: "project-1",
    auth: { clientId: "public-client", installId: 209, profile: "commercial" }, fetch: fetchImpl });
  return { client, requests, login: () => client.auth.login({ email: "user@example.com", password: "secret" }),
    counts: () => ({ refreshes, renewals, writes }), setLifetime: (n: number) => { lifetime = n; },
    setAuthLifetime: (n: number) => { authLifetime = n; }, failMint: () => { mintFailure = true; },
    revoke: () => { revoked = true; }, rejectPlatform: () => { platformStatus = 401; },
    holdRenewal: (fn: () => Promise<void>) => { hold = fn; } };
}

describe("unified Auth sessions", () => {
  test("one client logs in, calls apps, reads its user and logs out", async () => {
    const f = fixture(); await f.login();
    expect(f.client.auth.getSession()?.authorization?.roles).toEqual(["commercial"]);
    await f.client.app("conversations").get("/chats");
    expect((await f.client.auth.me()).id).toBe(42);
    expect(f.requests[0].body.client_id).toBe("public-client");
    expect(f.requests[0].token).toBeNull();
    expect(f.requests.find(r => r.path.endsWith("/me"))?.token).toBe("Bearer auth-0");
    expect(JSON.stringify(f.client.auth.getSession())).not.toContain("refresh-0");
    await f.client.auth.logout();
    expect(f.client.auth.getSession()).toBeUndefined();
    const before = f.requests.length;
    await expect(f.client.app("conversations").get("/chats")).rejects.toThrow("Login required");
    expect(f.requests.length).toBe(before);
  });
  test("near-expiry platform tokens renew once before concurrent requests", async () => {
    const f = fixture(); f.setLifetime(5); await f.login(); f.setLifetime(60);
    await Promise.all(Array.from({ length: 20 }, () => f.client.app("conversations").get("/chats")));
    expect(f.counts().renewals).toBe(1); expect(f.counts().refreshes).toBe(0);
  });
  test("normal Auth refresh is serialized with me and application calls", async () => {
    const f = fixture(); f.setAuthLifetime(1); f.setLifetime(1); await f.login(); f.setAuthLifetime(900); f.setLifetime(60);
    await Promise.all([f.client.auth.me(), ...Array.from({ length: 10 }, () => f.client.app("conversations").get("/chats"))]);
    expect(f.counts().refreshes).toBe(1);
    expect(f.requests.filter(r => r.path.endsWith("/refresh"))[0].body.refresh_token).toBe("refresh-0");
  });
  test("late renewal cannot restore a logged-out session", async () => {
    const f = fixture(); await f.login(); let release!: () => void;
    f.holdRenewal(() => new Promise(resolve => { release = resolve; }));
    const pending = f.client.auth.refresh();
    while (!release) await delay();
    await f.client.auth.logout(); release();
    await expect(pending).rejects.toThrow();
    expect(f.client.auth.getSession()).toBeUndefined(); expect(f.client.getAccessToken()).toBeUndefined();
  });
  test("disabled sessions cannot refresh, and are cleared", async () => {
    const f = fixture(); await f.login(); f.revoke();
    await expect(f.client.auth.refresh()).rejects.toThrow();
    expect(f.client.auth.getSession()).toBeUndefined();
  });
  test("mint outage preserves rotated Auth credentials and never falls back", async () => {
    const f = fixture(); f.setAuthLifetime(1); f.setLifetime(1); await f.login(); f.setAuthLifetime(900); f.failMint();
    await expect(f.client.app("conversations").get("/chats")).rejects.toThrow("503");
    expect(f.client.auth.getSession()?.user.id).toBe(42); expect(f.client.getAccessToken()).toBeUndefined();
    await f.client.auth.logout();
    expect(f.requests.at(-1)?.body.refresh_token).toBe("refresh-1");
  });
  test("excessive expiry is rejected even on successful login", async () => {
    const f = fixture(); f.setLifetime(3600);
    await expect(f.login()).rejects.toThrow("expiry");
    expect(f.client.getAccessToken()).toBeUndefined();
  });
  test("application 401 renews credentials without replaying writes", async () => {
    const f = fixture(); await f.login(); f.rejectPlatform();
    await expect(f.client.app("conversations").post("/send", {})).rejects.toThrow("401");
    expect(f.counts().writes).toBe(1); expect(f.counts().renewals).toBe(1);
  });
  test("Auth mode cannot fall back to administrator credentials", async () => {
    expect(() => new AptevaClient({ baseURL: "", projectId: "p", apiKey: "private", auth: { clientId: "c" } })).toThrow();
    const f = fixture(); await f.login();
    expect(() => f.client.setApiKey("private")).toThrow();
    expect(() => f.client.setAccessToken("private")).toThrow();
    await expect(f.client.auth.listKeys()).rejects.toThrow("403");
    await expect(f.client.app("conversations").get("/chats?api_key=private")).rejects.toThrow("403");
  });
  test("separate clients never share a refresh token implicitly", async () => {
    const a = fixture(), b = fixture(); await a.login();
    expect(b.client.auth.getSession()).toBeUndefined();
    await expect(b.client.app("conversations").get("/chats")).rejects.toThrow();
  });
});

test("managed streams renew on expiry and close on logout", async () => {
  let streams = 0, renewals = 0, cancelled = 0;
  const payload = () => ({ apteva_access_token: `platform-${renewals}`, apteva_expires_in: 1,
    apteva_expires_at: new Date(Date.now() + 1000).toISOString() });
  const client = new AptevaClient({ baseURL: "https://example.com", projectId: "p", auth: { clientId: "c" },
    fetch: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/login")) return Response.json({ user: { id: 1 }, access_token: "auth", refresh_token: "refresh", expires_in: 900, ...payload() });
      if (path.endsWith("/delegated-token")) { renewals++; return Response.json(payload()); }
      if (path.endsWith("/logout")) return new Response(null, { status: 204 });
      streams++;
      expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer platform-${renewals}`);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`id: ${streams}\ndata: {"ok":true}\n\n`));
        init!.signal!.addEventListener("abort", () => { cancelled++; controller.error(new Error("aborted")); });
      } }), { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch });
  await client.auth.login({ email: "e", password: "p" });
  let events = 0;
  const stream = client.subscribe("/api/apps/conversations/stream", {}, () => { events++; }, { reconnectDelayMs: 1 });
  try {
    for (let i=0; i<300 && events<2; i++) await delay();
    expect(events).toBeGreaterThanOrEqual(2); expect(renewals).toBeGreaterThanOrEqual(2);
    await client.auth.logout(); const count=streams;
    await delay(30); expect(streams).toBe(count); expect(cancelled).toBeGreaterThanOrEqual(2);
  } finally { stream.close(); }
});
