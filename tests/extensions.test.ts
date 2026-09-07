import { describe, expect, test } from "bun:test";
import {
  AptevaClient, AptevaError, AppComponentRegistry, defineAppExtension,
  checkAppCompatibility, assertAppCompatibility,
} from "../src";
import type { InstalledApp, AppScope } from "../src";

function mockClient() {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const client = new AptevaClient({
    baseURL: "https://example.com", accessToken: "first", projectId: "default",
    fetch: (async (url, init) => {
      requests.push({ url: new URL(String(url)), init: init! });
      return Response.json({ ok: true });
    }) as typeof fetch,
  });
  return { client, requests };
}

describe("app-owned extensions", () => {
  test("typed clients reuse live auth and isolated scope without caching", async () => {
    const { client, requests } = mockClient();
    const extension = defineAppExtension({
      app: "example",
      create: ({ app }) => ({ read: () => app.get<{ ok: boolean }>("/items"), app }),
    });
    const scope: AppScope = { projectId: "one", installId: 42 };
    const a = client.use(extension, scope);
    scope.projectId = "mutated";
    const b = client.use(extension, { projectId: "two", installId: 43 });
    expect(a).not.toBe(client.use(extension));
    expect((await a.read()).ok).toBe(true);
    client.setAccessToken("second");
    await b.read();
    expect(requests.map(r => r.url.searchParams.get("project_id"))).toEqual(["one", "two"]);
    expect(requests.map(r => r.url.searchParams.get("install_id"))).toEqual(["42", "43"]);
    expect(requests.map(r => new Headers(r.init.headers).get("Authorization"))).toEqual(["Bearer first", "Bearer second"]);
    expect(requests.every(r => r.init.credentials === "omit")).toBe(true);
  });

  test("async setup can validate app-owned API contracts", async () => {
    const { client } = mockClient();
    const result = await client.use(defineAppExtension({
      app: "example", create: async ({ app }) => (await app.get<{ ok: boolean }>("/contract")).ok,
    }));
    expect(result).toBe(true);
  });

  test("HTTP and MCP preserve options and explicit routing scope", async () => {
    const { client, requests } = mockClient();
    const app = client.app("example", { projectId: "chosen", installId: 12 });
    const init = { headers: { "Idempotency-Key": "operation-123" } };
    await app.get("/items?project_id=other&install_id=999", init);
    await app.post("/items", { x: 1 }, init);
    await app.put("/items", {}, init);
    await app.patch("/items", {}, init);
    await app.del("/items", init);
    await app.tool("create", { x: 1 }, init);
    for (const { url, init } of requests) {
      expect(url.searchParams.get("project_id")).toBe("chosen");
      expect(url.searchParams.get("install_id")).toBe("12");
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe("operation-123");
    }
    expect(JSON.parse(String(requests[5]!.init.body)).params).toEqual({ name: "create", arguments: { x: 1 } });
    const url = new URL(app.mcpURL({ project_id: "other", install_id: "999" }));
    expect(url.searchParams.get("project_id")).toBe("chosen");
    expect(url.searchParams.get("install_id")).toBe("12");
  });

  test("app paths cannot escape and installation IDs are validated", () => {
    const { client, requests } = mockClient();
    const app = client.app("example");
    for (const path of ["/../other/secret", "/%2e%2e/other", "//elsewhere", "https://elsewhere"]) {
      expect(() => app.get(path)).toThrow(AptevaError);
    }
    expect(() => client.app("example", { installId: -1 })).toThrow(AptevaError);
    expect(requests).toHaveLength(0);
  });

  test("app discovery uses the existing project-filtered platform endpoint", async () => {
    const { client, requests } = mockClient();
    await client.apps.list();
    await client.apps.list({ projectId: "another" });
    expect(requests.map(r => r.url.pathname + r.url.search)).toEqual([
      "/api/apps?project_id=default", "/api/apps?project_id=another",
    ]);
  });
});

describe("local component exports", () => {
  test("resolves app/name, detects duplicates atomically, and unregisters safely", () => {
    const registry = new AppComponentRegistry<(props: { title: string }) => string>();
    const card = ({ title }: { title: string }) => title;
    const remove = registry.register("example", { card });
    expect(registry.resolve({ app: "example", name: "card" })?.({ title: "hello" })).toBe("hello");
    expect(registry.resolve({ app: "other", name: "card" })).toBeUndefined();
    expect(() => registry.register("example", { added: card, card })).toThrow("already registered");
    expect(registry.resolve({ app: "example", name: "added" })).toBeUndefined();
    remove();
    registry.register("example", { card });
    remove();
    expect(registry.resolve({ app: "example", name: "card" })).toBe(card);
  });

  test("arbitrary names do not traverse object prototypes", () => {
    const registry = new AppComponentRegistry<string>();
    registry.register("__proto__", { constructor: "local export" });
    expect(registry.resolve({ app: "__proto__", name: "constructor" })).toBe("local export");
    expect(registry.resolve({ app: "__proto__", name: "toString" })).toBeUndefined();
  });
});

describe("advertised compatibility", () => {
  const installed: InstalledApp = {
    install_id: 12, name: "example", version: "1.2.0", project_id: "p", status: "running",
    surfaces: { mcp_tool_names: ["read"] },
    ui_components: [{ name: "card", entry: "/ui/Card.mjs", slots: ["chat.message_attachment"] }],
  };
  test("checks app identity, version policy and advertised features", () => {
    const requirements = { app: "example", tools: ["read"], components: ["card"],
      version: { description: "1.x", accepts: (version: string) => version.startsWith("1.") } };
    expect(checkAppCompatibility(installed, requirements)).toEqual({ compatible: true, issues: [] });
    expect(checkAppCompatibility({ ...installed, version: "2.0.0" }, requirements).compatible).toBe(false);
    expect(checkAppCompatibility(undefined, requirements).compatible).toBe(false);
    expect(checkAppCompatibility(installed, { app: "other" }).compatible).toBe(false);
    expect(() => assertAppCompatibility(installed, { app: "example", tools: ["send"] })).toThrow("missing tool: send");
    expect(checkAppCompatibility({ ...installed, surfaces: undefined, ui_components: undefined }, requirements).issues).toHaveLength(2);
  });
});
