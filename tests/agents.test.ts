import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AptevaClient } from "../src";
import { startStubServer, json, type StubServer } from "./stub-server";

let stub: StubServer;
beforeEach(() => {
  stub = startStubServer();
});
afterEach(async () => {
  await stub.stop();
});

const AGENT = {
  id: 3,
  user_id: 1,
  name: "researcher",
  directive: "find things",
  mode: "continuous",
  config: "{}",
  port: 3211,
  pid: 9001,
  status: "running" as const,
  project_id: "p1",
  created_at: "2026-05-14T08:00:00Z",
};

describe("agents namespace", () => {
  test("list hits GET /api/agents", async () => {
    stub.setRoute("GET", "/api/agents", () => json([AGENT]));
    const c = new AptevaClient({ baseURL: stub.url });
    const agents = await c.agents.list();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe("researcher");
    expect(stub.last()?.path).toBe("/api/agents");
  });

  test("get hits GET /api/agents/:id", async () => {
    stub.setRoute("GET", "/api/agents/3", () => json(AGENT));
    const c = new AptevaClient({ baseURL: stub.url });
    const a = await c.agents.get(3);
    expect(a.id).toBe(3);
    expect(stub.last()?.path).toBe("/api/agents/3");
  });

  test("status hits GET /api/agents/:id/status", async () => {
    stub.setRoute("GET", "/api/agents/3/status", () =>
      json({
        iteration: 42,
        rate: "1/s",
        model: "claude-opus-4-7",
        paused: false,
        threads: 2,
        memories: 17,
        uptime_seconds: 3600,
        mode: "continuous",
      }),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    const s = await c.agents.status(3);
    expect(s.iteration).toBe(42);
    expect(s.paused).toBe(false);
  });

  test("threads + channels route correctly", async () => {
    stub.setRoute("GET", "/api/agents/3/threads", () =>
      json([{ id: "t1", depth: 0, directive: "root", iteration: 1, rate: "1/s", model: "m", age: "1m" }]),
    );
    stub.setRoute("GET", "/api/agents/3/channels", () =>
      json([{ name: "slack", type: "slack", connected: true }]),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    const threads = await c.agents.threads(3);
    const channels = await c.agents.channels(3);
    expect(threads[0]?.id).toBe("t1");
    expect(channels[0]?.connected).toBe(true);
  });

  test("chatHistory passes the limit query param", async () => {
    stub.setRoute("GET", "/api/agents/3/chat-history", () =>
      json([{ id: "m1", role: "agent", text: "hi", time: "2026-05-14T08:01:00Z" }]),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    await c.agents.chatHistory(3, 10);
    expect(stub.last()?.path).toBe("/api/agents/3/chat-history");
    expect(new URL(stub.last()!.url).searchParams.get("limit")).toBe("10");
  });

  test("chatHistory defaults limit to 50", async () => {
    stub.setRoute("GET", "/api/agents/3/chat-history", () => json([]));
    const c = new AptevaClient({ baseURL: stub.url });
    await c.agents.chatHistory(3);
    expect(new URL(stub.last()!.url).searchParams.get("limit")).toBe("50");
  });

  test("apiKey carries through to agent routes", async () => {
    stub.setRoute("GET", "/api/agents", () => json([]));
    const c = new AptevaClient({ baseURL: stub.url, apiKey: "sk-a" });
    await c.agents.list();
    expect(stub.last()?.headers["authorization"]).toBe("Bearer sk-a");
  });
});
