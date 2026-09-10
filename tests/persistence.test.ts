import { afterEach, expect, test } from "bun:test";
import { AuthSession, type AppAuthOptions } from "../src/auth-session";
import type { PersistenceEnvironment } from "../src/session-persistence";
const sessions: AuthSession[] = [];
afterEach(() => { sessions.splice(0).forEach(s => s.dispose()); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture() {
  const data = new Map<string, string>();
  const observers = new Map<number, { key: string; fn: () => void }>();
  const queues = new Map<string, Promise<unknown>>();
  const records = new Map<string, { family: number; used: boolean; user: number }>();
  const revoked = new Set<number>();
  let tabs = 0, version = 0, family = 0, refreshes = 0, logouts = 0, reuses = 0;
  let gate: Promise<void> | undefined, mode = "ok", failWrite = false, failRead = false;
  const events: unknown[] = [];
  const notify = (id: number, key: string) => { events.push({ key }); queueMicrotask(() => {
    for (const [tab, observer] of observers) if (id !== tab && observer.key === key) observer.fn();
  }); };
  const environment = (): PersistenceEnvironment => {
    const id = ++tabs;
    return {
      storage: { get length() { return data.size; }, key: n => [...data.keys()][n] ?? null,
        getItem: key => { if (failRead) throw Error("storage denied"); return data.get(key) ?? null; },
        setItem: (key, value) => { if (failWrite) throw Error("quota"); data.set(key, value); notify(id, key); },
        removeItem: key => { data.delete(key); notify(id, key); }, clear: () => data.clear() },
      locks: { request: ((key: string, _opts: unknown, run: () => Promise<unknown>) => {
        const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
        queues.set(key, next); return next;
      }) as LockManager["request"] },
      subscribe: (key, fn) => { observers.set(id, { key, fn }); return () => { observers.delete(id); }; },
      publish: key => notify(id, key), close: () => { observers.delete(id); },
    };
  };
  const response = (f: number, user: number) => {
    const refresh = `refresh-${++version}`; records.set(refresh, { family: f, used: false, user });
    return { user: { id: user }, access_token: `auth-${version}`, refresh_token: refresh, expires_in: 900,
      authorization: { roles: [user === 1 ? "user" : "admin"], permissions: [], authorization_version: version },
      ...(mode !== "platform-denied" ? { apteva_access_token: `platform-${version}`, apteva_expires_in: 60, apteva_expires_at: new Date(Date.now() + 60000).toISOString() } : {}) };
  };
  const fetchImpl = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.endsWith("/login")) return Response.json(response(++family, body.email === "bob" ? 2 : 1));
    if (path.endsWith("/logout")) { logouts++; const record = records.get(body.refresh_token); if (record) revoked.add(record.family); return new Response(null, { status: 204 }); }
    if (path.endsWith("/refresh")) {
      refreshes++;
      if (gate) await gate;
      if (mode === "safe503") return Response.json({ error: "refresh_unavailable" }, { status: 503 });
      if (mode === "proxy503") return new Response("unavailable", { status: 503 });
      const record = records.get(body.refresh_token);
      if (!record || revoked.has(record.family)) return Response.json({ error: "invalid_grant" }, { status: 401 });
      if (record.used) { reuses++; revoked.add(record.family); return Response.json({ error: "invalid_grant" }, { status: 401 }); }
      record.used = true;
      const result = response(record.family, record.user);
      if (mode === "lost") throw Error("response lost");
      if (mode === "write-failure") failWrite = true;
      return Response.json(result);
    }
    if (path.endsWith("/delegated-token")) return new Response("denied", { status: 403 });
    return Response.json({ user: { id: 1 } });
  }) as typeof fetch;
  const tab = (options: Partial<AppAuthOptions> = {}, env = environment(), base = "https://server.test", project = "p") => {
    const session = new AuthSession(base, project, { clientId: "public", persistence: "local", ...options }, fetchImpl, () => {}, env);
    sessions.push(session); return session;
  };
  return { data, events, environment, tab, login: (s: AuthSession, email = "alice") => s.login({ email, password: "secret" }),
    counts: () => ({ refreshes, logouts, reuses }), mode: (m: string) => { mode = m; }, gate: (p: Promise<void>) => { gate = p; },
    failWrite: () => { failWrite = true; }, failRead: () => { failRead = true; }, revoke: () => { revoked.add(family); },
  };
}

test("reload restoration persists only a versioned refresh credential and authoritative metadata stays in memory", async () => {
  const f = fixture(), a = f.tab(); await f.login(a); a.dispose();
  const record = JSON.parse([...f.data.values()][0]);
  expect(Object.keys(record).sort()).toEqual(["generation", "refreshToken", "revision", "scope", "state", "version"]);
  expect(JSON.stringify(record)).not.toContain("auth-"); expect(JSON.stringify(record)).not.toContain("platform-");
  const b = f.tab(); expect(b.getState().status).toBe("idle");
  const restored = await b.restore(); expect(restored?.user.id).toBe(1); expect(restored?.authorization?.authorization_version).toBe(2);
  expect(JSON.stringify(b.info())).not.toContain("refresh-"); expect(JSON.stringify(f.events)).not.toContain("refresh-");
  expect(JSON.parse([...f.data.values()][0]).refreshToken).toBe("refresh-2");
});

test("concurrent restore calls share one operation and protected credentials wait", async () => {
  const f = fixture(); await f.login(f.tab()); const b = f.tab();
  let release!: () => void; f.gate(new Promise(resolve => { release = resolve; }));
  const a = b.restore(), same = b.restore(); expect(a).toBe(same); expect(b.getState().status).toBe("restoring");
  const credential = b.credential("auth"); await tick(); expect(f.counts().refreshes).toBe(1);
  release(); await Promise.all([a, same, credential]); expect(f.counts().refreshes).toBe(1);
});

test("simultaneous tabs re-read under Web Locks and never reuse rotating credentials", async () => {
  const f = fixture(); await f.login(f.tab());
  const tabs = [f.tab(), f.tab(), f.tab()];
  await Promise.all(tabs.map(t => t.restore()));
  expect(f.counts()).toMatchObject({ refreshes: 3, reuses: 0 });
  await Promise.all(tabs.map(t => t.credential("auth")));
  expect(f.counts().reuses).toBe(0);
});

test("logout clears storage credentials and other tabs, and closes their streams", async () => {
  const f = fixture(), a = f.tab(); await f.login(a); const b = f.tab(); await b.restore();
  let closed = 0; a.onClear(() => { closed++; }); b.onClear(() => { closed++; });
  await a.logout(); await tick();
  expect(a.info()).toBeUndefined(); expect(b.info()).toBeUndefined(); expect(closed).toBe(2);
  expect(JSON.parse([...f.data.values()][0]).state).toBe("logged-out"); expect([...f.data.values()][0]).not.toContain("refreshToken");
  expect(await f.tab().restore()).toBeUndefined(); expect(f.counts().reuses).toBe(0);
});

test("account switching during restoration cannot revive the previous user", async () => {
  const f = fixture(); await f.login(f.tab()); const b = f.tab();
  let release!: () => void; f.gate(new Promise(resolve => { release = resolve; }));
  const restore = b.restore(); const failure = restore.catch(() => {}); await tick();
  const login = f.login(b, "bob"); release(); await failure; await login;
  expect(b.info()?.user.id).toBe(2); expect((await f.tab().restore())?.user.id).toBe(2);
});

test("logout during restoration prevents late acceptance and revokes the rotated family", async () => {
  const f = fixture(); await f.login(f.tab()); const b = f.tab();
  let release!: () => void; f.gate(new Promise(resolve => { release = resolve; }));
  const restore = b.restore().catch(() => {}); await tick(); const logout = b.logout(); release();
  await Promise.all([restore, logout]); expect(b.info()).toBeUndefined(); expect(f.counts().logouts).toBe(1);
  expect(await f.tab().restore()).toBeUndefined();
});

test("definitive revocation clears the saved session", async () => {
  const f = fixture(); await f.login(f.tab()); f.revoke(); const b = f.tab();
  await expect(b.restore()).rejects.toThrow(); expect(b.info()).toBeUndefined();
  expect(JSON.parse([...f.data.values()][0]).state).toBe("logged-out");
});

test("explicit pre-commit failure preserves the refresh for a successful retry", async () => {
  const f = fixture(); await f.login(f.tab()); f.mode("safe503"); const b = f.tab();
  await expect(b.restore()).rejects.toThrow(); expect(b.getState().status).toBe("error");
  expect(JSON.parse([...f.data.values()][0]).state).toBe("active");
  f.mode("ok"); expect((await b.restore())?.user.id).toBe(1); expect(f.counts().reuses).toBe(0);
});

for (const mode of ["lost", "proxy503"]) test(`${mode} leaves an uncertain marker and never replays the saved refresh`, async () => {
  const f = fixture(); await f.login(f.tab()); f.mode(mode); const b = f.tab();
  await expect(b.restore()).rejects.toThrow(); const count = f.counts().refreshes;
  f.mode("ok"); await expect(f.tab().restore()).rejects.toThrow("Previous refresh");
  expect(f.counts().refreshes).toBe(count); expect(f.counts().reuses).toBe(0);
});

test("a durable in-flight marker left by a crashed tab requires login", async () => {
  const f = fixture(); await f.login(f.tab()); const [key, raw] = [...f.data][0];
  f.data.set(key, JSON.stringify({ ...JSON.parse(raw), state: "refreshing" }));
  await expect(f.tab().restore()).rejects.toThrow("Previous refresh"); expect(f.counts().refreshes).toBe(0);
});

test("platform mint denial does not prevent Auth restoration", async () => {
  const f = fixture(); await f.login(f.tab()); f.mode("platform-denied"); const b = f.tab(); await b.restore();
  expect((await b.credential("auth")).token).toStartWith("auth-");
  await expect(b.credential("platform")).rejects.toThrow("403"); expect(b.info()?.user.id).toBe(1);
});

test("missing locks or blocked storage falls back to memory-only login", async () => {
  for (const kind of ["locks", "storage"]) {
    const f = fixture(), env = f.environment();
    if (kind === "locks") env.locks = {} as any; else f.failWrite();
    const a = f.tab({}, env); expect(a.getState().persistence).toBe("unavailable");
    await f.login(a); expect(a.info()?.user.id).toBe(1); expect(f.data.size).toBe(0);
  }
});

test("failed save after rotation keeps the new credential in memory and blocks stale restoration", async () => {
  const f = fixture(); await f.login(f.tab()); f.mode("write-failure"); const b = f.tab(); await b.restore();
  expect(b.getState().persistence).toBe("unavailable"); expect(b.info()?.user.id).toBe(1);
  expect(JSON.parse([...f.data.values()][0]).state).toBe("refreshing"); expect(f.counts().reuses).toBe(0);
});

test("scope changes never import another server, project, install, organization, client or profile session", async () => {
  const f = fixture(); await f.login(f.tab());
  for (const options of [{ clientId: "other" }, { installId: 2 }, { organizationSlug: "other" }, { profile: "other" }]) expect(await f.tab(options).restore()).toBeUndefined();
  expect(await f.tab({}, f.environment(), "https://other.test").restore()).toBeUndefined();
  expect(await f.tab({}, f.environment(), "https://server.test", "other").restore()).toBeUndefined();
  expect(f.counts().refreshes).toBe(0);
});

test("unsupported or tampered storage fails closed without network requests", async () => {
  const f = fixture(); await f.login(f.tab()); const [key, raw] = [...f.data][0];
  f.data.set(key, JSON.stringify({ ...JSON.parse(raw), version: 99 }));
  const b = f.tab(); await expect(b.restore()).rejects.toThrow("invalid"); expect(f.counts().refreshes).toBe(0);
});

test("storage loss during an established shared session never rotates a stale private copy", async () => {
  const f = fixture(), a = f.tab(); await f.login(a); f.failRead();
  await expect(a.credential("auth")).rejects.toThrow(); expect(a.info()).toBeUndefined();
  expect(a.getState().persistence).toBe("unavailable"); expect(f.counts().refreshes).toBe(0);
  await f.login(a); expect(a.info()?.user.id).toBe(1);
});

test("login and logout can replace an unsupported storage format", async () => {
  const f = fixture(), a = f.tab(); await f.login(a); const [key] = [...f.data.keys()]; f.data.set(key, "broken");
  await a.logout(); expect(JSON.parse(f.data.get(key)!).state).toBe("logged-out");
  f.data.set(key, "broken"); await f.login(a, "bob"); expect(a.info()?.user.id).toBe(2);
});

test("Web Lock rejection reports unavailable and a fresh login falls back without a shared refresh", async () => {
  const f = fixture(), env = f.environment(); env.locks.request = (() => Promise.reject(Error("locks denied"))) as any;
  const a = f.tab({}, env); await f.login(a);
  expect(a.getState().persistence).toBe("unavailable"); expect(a.info()?.user.id).toBe(1); expect(f.data.size).toBe(0);
});

test("explicit memory mode never reads or writes browser storage", async () => {
  const f = fixture(); f.failRead(); f.failWrite(); const a = f.tab({ persistence: "memory" });
  await f.login(a); expect(a.getState().persistence).toBe("memory"); expect(a.info()?.user.id).toBe(1);
});
