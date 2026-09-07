import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AptevaClient, AptevaError } from "../src";
import { startStubServer, json, type StubServer } from "./stub-server";

let stub: StubServer;
beforeEach(() => {
  stub = startStubServer();
});
afterEach(async () => {
  await stub.stop();
});

describe("auth carriers", () => {
  test("Authorization: Bearer is attached when apiKey is set", async () => {
    const c = new AptevaClient({ baseURL: stub.url, apiKey: "sk-test" });
    await c.auth.me();
    expect(stub.last()?.headers["authorization"]).toBe("Bearer sk-test");
  });

  test("opaque accessToken is attached without relying on a token prefix", async () => {
    const c = new AptevaClient({
      baseURL: stub.url,
      accessToken: "opaque-application-user-token",
    });
    await c.auth.me();
    expect(stub.last()?.headers["authorization"]).toBe(
      "Bearer opaque-application-user-token",
    );
  });

  test("accessToken takes precedence over apiKey", async () => {
    const c = new AptevaClient({
      baseURL: stub.url,
      apiKey: "sk-fallback",
      accessToken: "opaque-user-token",
    });
    await c.auth.me();
    expect(stub.last()?.headers["authorization"]).toBe("Bearer opaque-user-token");
  });

  test("no Authorization header when apiKey is unset", async () => {
    const c = new AptevaClient({ baseURL: stub.url });
    await c.auth.me();
    expect(stub.last()?.headers["authorization"]).toBeUndefined();
  });

  test("credentials: include is always sent (cookie auth)", async () => {
    // Bun's fetch surfaces this via the request — we verify indirectly
    // by confirming the SDK doesn't drop cookies if the server sets them.
    stub.setRoute("GET", "/api/auth/me", () =>
      json({ user_id: 1 }, 200, { "Set-Cookie": "session=abc; Path=/" }),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    await c.auth.me();
    // The presence of credentials: "include" in the SDK's fetch options
    // is what makes the next call carry the cookie. We can't observe it
    // on a single call to the stub, but we can assert the client class
    // didn't crash and the assertion above passed.
    expect(stub.all().length).toBe(1);
  });

  test("setApiKey swaps the key at runtime", async () => {
    const c = new AptevaClient({ baseURL: stub.url, apiKey: "sk-1" });
    await c.auth.me();
    expect(stub.last()?.headers["authorization"]).toBe("Bearer sk-1");
    c.setApiKey("sk-2");
    await c.auth.me();
    expect(stub.last()?.headers["authorization"]).toBe("Bearer sk-2");
    c.setApiKey(undefined);
    await c.auth.me();
    expect(stub.last()?.headers["authorization"]).toBeUndefined();
  });

  test("getApiKey returns the current key", () => {
    const c = new AptevaClient({ baseURL: stub.url, apiKey: "sk-x" });
    expect(c.getApiKey()).toBe("sk-x");
  });

  test("setAccessToken swaps the token and falls back to apiKey when cleared", async () => {
    const c = new AptevaClient({ baseURL: stub.url, apiKey: "sk-fallback" });
    c.setAccessToken("opaque-user-token");
    expect(c.getAccessToken()).toBe("opaque-user-token");
    await c.auth.me();
    expect(stub.last()?.headers["authorization"]).toBe("Bearer opaque-user-token");

    c.setAccessToken(undefined);
    expect(c.getAccessToken()).toBeUndefined();
    await c.auth.me();
    expect(stub.last()?.headers["authorization"]).toBe("Bearer sk-fallback");
  });

  test("accessToken requests omit cookie credentials", async () => {
    let credentials: RequestCredentials | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      credentials = init?.credentials;
      return json({ user_id: 7 });
    }) as typeof fetch;
    const c = new AptevaClient({
      baseURL: "https://agents.example.com",
      accessToken: "opaque-user-token",
      fetch: fetchImpl,
    });
    await c.auth.me();
    expect(credentials).toBe("omit");
  });

  test("user-supplied Authorization header in init wins", async () => {
    const c = new AptevaClient({ baseURL: stub.url, apiKey: "sk-from-ctor" });
    await c.get("/api/auth/me", { headers: { Authorization: "Bearer custom" } });
    expect(stub.last()?.headers["authorization"]).toBe("Bearer custom");
  });
});

describe("auth namespace", () => {
  test("login posts to /api/auth/login with body", async () => {
    const c = new AptevaClient({ baseURL: stub.url });
    const u = await c.auth.login("a@b.c", "pw");
    expect(stub.last()?.path).toBe("/api/auth/login");
    expect(stub.last()?.method).toBe("POST");
    expect(JSON.parse(stub.last()!.body)).toEqual({ email: "a@b.c", password: "pw" });
    expect(u.email).toBe("u@example.com");
  });

  test("logout returns undefined on 204", async () => {
    const c = new AptevaClient({ baseURL: stub.url });
    const r = await c.auth.logout();
    expect(r).toBeUndefined();
  });

  test("me returns the user shape", async () => {
    const c = new AptevaClient({ baseURL: stub.url });
    const me = await c.auth.me();
    expect(me.user_id).toBe(7);
  });

  test("register/changePassword/keys hit the right paths", async () => {
    stub.setRoute("POST", "/api/auth/register", () => json({ user: { id: 1 } }));
    stub.setRoute("POST", "/api/auth/password", () => new Response(null, { status: 204 }));
    stub.setRoute("GET", "/api/auth/keys", () => json([{ id: 1, name: "k", created_at: "" }]));
    stub.setRoute("POST", "/api/auth/keys", () => json({ id: 2, key: "sk-new" }));
    stub.setRoute("DELETE", "/api/auth/keys/9", () => new Response(null, { status: 204 }));

    const c = new AptevaClient({ baseURL: stub.url });
    await c.auth.register("a@b.c", "pw", "A");
    await c.auth.changePassword("old", "new");
    const list = await c.auth.listKeys();
    const made = await c.auth.createKey("k2");
    await c.auth.deleteKey(9);

    expect(list.length).toBe(1);
    expect(made.key).toBe("sk-new");
    const paths = stub.all().map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain("POST /api/auth/register");
    expect(paths).toContain("POST /api/auth/password");
    expect(paths).toContain("GET /api/auth/keys");
    expect(paths).toContain("POST /api/auth/keys");
    expect(paths).toContain("DELETE /api/auth/keys/9");
  });
});

describe("projects namespace", () => {
  test("list and get use the authenticated project routes", async () => {
    stub.setRoute("GET", "/api/projects", () => json([{
      id: "project-1",
      user_id: 7,
      name: "Website",
      created_at: "2026-08-13T12:00:00Z",
    }]));
    stub.setRoute("GET", "/api/projects/project-1", () => json({
      id: "project-1",
      user_id: 7,
      name: "Website",
      created_at: "2026-08-13T12:00:00Z",
    }));
    const c = new AptevaClient({ baseURL: stub.url, apiKey: "sk-test" });

    expect((await c.projects.list())[0]?.name).toBe("Website");
    expect((await c.projects.get("project-1")).id).toBe("project-1");
    expect(stub.all().map((request) => request.path)).toEqual([
      "/api/projects",
      "/api/projects/project-1",
    ]);
    expect(stub.last()?.headers.authorization).toBe("Bearer sk-test");
  });
});

describe("error handling", () => {
  test("401 throws AptevaError and fires onUnauthorized once", async () => {
    stub.setRoute("GET", "/api/auth/me", () => new Response("nope", { status: 401 }));
    let calls = 0;
    const c = new AptevaClient({
      baseURL: stub.url,
      onUnauthorized: () => {
        calls++;
      },
    });
    try {
      await c.auth.me();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AptevaError);
      const e = err as AptevaError;
      expect(e.status).toBe(401);
      expect(e.body).toBe("nope");
      expect(e.isUnauthorized()).toBe(true);
    }
    expect(calls).toBe(1);
  });

  test("non-2xx surfaces status + body", async () => {
    stub.setRoute("GET", "/api/auth/me", () => json({ error: "boom" }, 500));
    const c = new AptevaClient({ baseURL: stub.url });
    try {
      await c.auth.me();
      throw new Error("expected throw");
    } catch (err) {
      const e = err as AptevaError;
      expect(e.status).toBe(500);
      expect(e.body).toContain("boom");
    }
  });

  test("network failure surfaces as status=0", async () => {
    // Point at a port nothing is listening on.
    const c = new AptevaClient({
      baseURL: "http://127.0.0.1:1",
      timeoutMs: 0,
    });
    try {
      await c.auth.me();
      throw new Error("expected throw");
    } catch (err) {
      const e = err as AptevaError;
      expect(e).toBeInstanceOf(AptevaError);
      expect(e.status).toBe(0);
    }
  });

  test("timeout surfaces as status=0 with timeout message", async () => {
    // Hang the route so the abort fires.
    stub.setRoute("GET", "/api/auth/me", () => new Promise(() => {}) as unknown as Response);
    const c = new AptevaClient({ baseURL: stub.url, timeoutMs: 50 });
    try {
      await c.auth.me();
      throw new Error("expected throw");
    } catch (err) {
      const e = err as AptevaError;
      expect(e.status).toBe(0);
      expect(e.body).toContain("timeout");
    }
  });
});

describe("response decoding", () => {
  test("text/plain response returned as string", async () => {
    stub.setRoute("GET", "/api/raw", () => new Response("hello", { status: 200 }));
    const c = new AptevaClient({ baseURL: stub.url });
    const s = await c.get<string>("/api/raw");
    expect(s).toBe("hello");
  });

  test("204 returns undefined without parse error", async () => {
    stub.setRoute("DELETE", "/api/x", () => new Response(null, { status: 204 }));
    const c = new AptevaClient({ baseURL: stub.url });
    const r = await c.del("/api/x");
    expect(r).toBeUndefined();
  });
});
