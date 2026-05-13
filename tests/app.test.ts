import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApteveClient, ApteveError, unwrapMCP } from "../src";
import { startStubServer, json, type StubServer } from "./stub-server";

let stub: StubServer;
beforeEach(() => {
  stub = startStubServer();
});
afterEach(async () => {
  await stub.stop();
});

describe("app handle — HTTP routes", () => {
  test("GET hits /api/apps/<name>/<path>", async () => {
    stub.setRoute("GET", "/api/apps/flexylead/leads", () =>
      json({ leads: [{ id: 1, name: "A" }] }),
    );
    const c = new ApteveClient({ baseURL: stub.url });
    const res = await c.app<{ leads: { id: number; name: string }[] }>("flexylead").get("/leads");
    expect(res.leads[0]?.id).toBe(1);
  });

  test("POST forwards body as JSON", async () => {
    stub.setRoute("POST", "/api/apps/flexylead/leads", () => json({ id: 42 }));
    const c = new ApteveClient({ baseURL: stub.url });
    const r = await c.app("flexylead").post<{ id: number }>("/leads", { name: "X" });
    expect(r.id).toBe(42);
    expect(JSON.parse(stub.last()!.body)).toEqual({ name: "X" });
    expect(stub.last()?.headers["content-type"]).toContain("application/json");
  });

  test("PUT / PATCH / DELETE route correctly", async () => {
    stub.setRoute("PUT", "/api/apps/flexylead/leads/1", () => json({ ok: true }));
    stub.setRoute("PATCH", "/api/apps/flexylead/leads/1", () => json({ ok: true }));
    stub.setRoute("DELETE", "/api/apps/flexylead/leads/1", () =>
      new Response(null, { status: 204 }),
    );
    const c = new ApteveClient({ baseURL: stub.url });
    const app = c.app("flexylead");
    await app.put("/leads/1", { name: "U" });
    await app.patch("/leads/1", { name: "P" });
    await app.del("/leads/1");
    const methods = stub.all().map((c) => c.method);
    expect(methods).toEqual(["PUT", "PATCH", "DELETE"]);
  });

  test("app name is URL-encoded", async () => {
    stub.setRoute("GET", "/api/apps/weird%20name/x", () => json({ ok: true }));
    const c = new ApteveClient({ baseURL: stub.url });
    await c.app("weird name").get("/x");
    expect(stub.last()?.path).toBe("/api/apps/weird%20name/x");
  });

  test("apiKey carries through to app routes", async () => {
    stub.setRoute("GET", "/api/apps/flexylead/x", () => json({ ok: true }));
    const c = new ApteveClient({ baseURL: stub.url, apiKey: "sk-app" });
    await c.app("flexylead").get("/x");
    expect(stub.last()?.headers["authorization"]).toBe("Bearer sk-app");
  });
});

describe("app handle — MCP tools", () => {
  test("tool() sends valid JSON-RPC envelope to /mcp", async () => {
    stub.setRoute("POST", "/api/apps/flexylead/mcp", () =>
      json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: JSON.stringify({ leads: [{ id: 9 }] }) }],
        },
      }),
    );
    const c = new ApteveClient({ baseURL: stub.url });
    const r = await c.app("flexylead").tool<{ leads: { id: number }[] }>("leads_list", {
      limit: 50,
    });
    expect(r.leads[0]?.id).toBe(9);
    const sent = JSON.parse(stub.last()!.body);
    expect(sent.method).toBe("tools/call");
    expect(sent.params.name).toBe("leads_list");
    expect(sent.params.arguments).toEqual({ limit: 50 });
  });

  test("tool() with no args defaults to empty object", async () => {
    stub.setRoute("POST", "/api/apps/flexylead/mcp", () =>
      json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "null" }] },
      }),
    );
    const c = new ApteveClient({ baseURL: stub.url });
    await c.app("flexylead").tool("leads_ping");
    const sent = JSON.parse(stub.last()!.body);
    expect(sent.params.arguments).toEqual({});
  });

  test("MCP error envelope throws ApteveError(-1, message)", async () => {
    stub.setRoute("POST", "/api/apps/flexylead/mcp", () =>
      json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "bad arg" },
      }),
    );
    const c = new ApteveClient({ baseURL: stub.url });
    try {
      await c.app("flexylead").tool("leads_list", {});
      throw new Error("expected throw");
    } catch (err) {
      const e = err as ApteveError;
      expect(e.status).toBe(-1);
      expect(e.body).toBe("bad arg");
      expect(e.code).toBe(-32602);
    }
  });

  test("mcpURL builds the right absolute URL", () => {
    const c = new ApteveClient({ baseURL: "https://example.com" });
    expect(c.app("flexylead").mcpURL()).toBe("https://example.com/api/apps/flexylead/mcp");
    expect(c.app("flexylead").mcpURL({ api_key: "sk-x" })).toBe(
      "https://example.com/api/apps/flexylead/mcp?api_key=sk-x",
    );
  });
});

describe("unwrapMCP (unit)", () => {
  test("returns parsed JSON from result.content[0].text", () => {
    const out = unwrapMCP<{ a: number }>({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: '{"a":7}' }] },
    });
    expect(out).toEqual({ a: 7 });
  });

  test("throws on error envelope", () => {
    expect(() =>
      unwrapMCP({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -1, message: "x" },
      }),
    ).toThrow(ApteveError);
  });

  test("passes through unwrapped responses for short-circuit mocks", () => {
    const out = unwrapMCP<{ a: number }>({ a: 7 } as never);
    expect(out).toEqual({ a: 7 });
  });

  test("throws when content text is not valid JSON", () => {
    expect(() =>
      unwrapMCP({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "not-json" }] },
      }),
    ).toThrow(/not valid JSON/);
  });
});

describe("sseURL", () => {
  test("appends api_key from client", () => {
    const c = new ApteveClient({ baseURL: "https://example.com", apiKey: "sk-y" });
    const u = c.sseURL("/api/events", { project_id: "p1" });
    expect(u).toBe("https://example.com/api/events?project_id=p1&api_key=sk-y");
  });

  test("does not override explicit api_key in params", () => {
    const c = new ApteveClient({ baseURL: "https://example.com", apiKey: "sk-from-ctor" });
    const u = c.sseURL("/api/events", { api_key: "sk-explicit" });
    expect(u).toBe("https://example.com/api/events?api_key=sk-explicit");
  });

  test("omits api_key when not set", () => {
    const c = new ApteveClient({ baseURL: "https://example.com" });
    const u = c.sseURL("/api/events", { project_id: "p1" });
    expect(u).toBe("https://example.com/api/events?project_id=p1");
  });
});
