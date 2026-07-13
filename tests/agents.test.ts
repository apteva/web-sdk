import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AptevaClient } from "../src";
import type { EventSourceCtor, EventSourceLike } from "../src";
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

class FakeEventSource implements EventSourceLike {
  static last: FakeEventSource | undefined;
  url: string;
  withCredentials: boolean;
  closed = false;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.last = this;
  }
  addEventListener(type: "message" | "error", fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  close() {
    this.closed = true;
  }
  emitMessage(data: string) {
    for (const fn of this.listeners["message"] ?? []) fn({ data });
  }
}

const FakeES = FakeEventSource as unknown as EventSourceCtor;

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

  test("create posts to /api/agents and returns an Agent", async () => {
    stub.setRoute("POST", "/api/agents", () => json({ ...AGENT, name: "ops" }));
    const c = new AptevaClient({ baseURL: stub.url });
    const a = await c.agents.create({
      name: "ops",
      directive: "watch systems",
      mode: "cautious",
      project_id: "p1",
      start: false,
      include_channels: true,
      bound_connection_ids: [11],
    });
    expect(stub.last()?.method).toBe("POST");
    expect(stub.last()?.path).toBe("/api/agents");
    expect(JSON.parse(stub.last()!.body)).toEqual({
      name: "ops",
      directive: "watch systems",
      mode: "cautious",
      project_id: "p1",
      start: false,
      include_channels: true,
      bound_connection_ids: [11],
    });
    expect(a.name).toBe("ops");
  });

  test("create returns warning shapes when the server creates but cannot start", async () => {
    stub.setRoute("POST", "/api/agents", () =>
      json({ id: 4, name: "ops", status: "stopped", warning: "no LLM provider configured" }),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    const r = await c.agents.create({ name: "ops" });
    expect("warning" in r ? r.warning : "").toContain("provider");
  });

  test("update, rename, and delete route correctly", async () => {
    stub.setRoute("PUT", "/api/agents/3", () => json({ ...AGENT, name: "renamed" }));
    const c = new AptevaClient({ baseURL: stub.url });
    const updated = await c.agents.update(3, { name: "renamed" });
    expect(stub.last()?.path).toBe("/api/agents/3");
    expect(JSON.parse(stub.last()!.body)).toEqual({ name: "renamed" });
    expect(updated.name).toBe("renamed");

    await c.agents.rename(3, "short");
    expect(JSON.parse(stub.last()!.body)).toEqual({ name: "short" });

    stub.setRoute("DELETE", "/api/agents/3", () => json({ status: "deleted" }));
    const deleted = await c.agents.delete(3);
    expect(stub.last()?.method).toBe("DELETE");
    expect(stub.last()?.path).toBe("/api/agents/3");
    expect(deleted.status).toBe("deleted");
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

  test("config helpers get and update /api/agents/:id/config", async () => {
    stub.setRoute("GET", "/api/agents/3/config", () =>
      json({ directive: "old", mode: "autonomous" }),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    const config = await c.agents.config(3);
    expect(stub.last()?.path).toBe("/api/agents/3/config");
    expect(config.directive).toBe("old");

    stub.setRoute("PUT", "/api/agents/3/config", () =>
      json({ directive: "new", mode: "learn" }),
    );
    const next = await c.agents.updateConfig(3, {
      directive: "new",
      mode: "learn",
      mcp_servers: [{ name: "storage" }],
    });
    expect(stub.last()?.method).toBe("PUT");
    expect(stub.last()?.path).toBe("/api/agents/3/config");
    expect(JSON.parse(stub.last()!.body)).toEqual({
      directive: "new",
      mode: "learn",
      mcp_servers: [{ name: "storage" }],
    });
    expect(next.mode).toBe("learn");
  });

  test("systemMCP toggles /api/agents/:id/system-mcp", async () => {
    stub.setRoute("POST", "/api/agents/3/system-mcp", () =>
      json({ name: "channels", enable: false, previous: true, restart_required: true }),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    const r = await c.agents.systemMCP(3, "channels", false);
    expect(stub.last()?.path).toBe("/api/agents/3/system-mcp");
    expect(JSON.parse(stub.last()!.body)).toEqual({ name: "channels", enable: false });
    expect(r.restart_required).toBe(true);
  });

  test("apiKey carries through to agent routes", async () => {
    stub.setRoute("GET", "/api/agents", () => json([]));
    const c = new AptevaClient({ baseURL: stub.url, apiKey: "sk-a" });
    await c.agents.list();
    expect(stub.last()?.headers["authorization"]).toBe("Bearer sk-a");
  });
});

describe("agents namespace — lifecycle", () => {
  test("start POSTs /api/agents/:id/start and returns the Agent", async () => {
    stub.setRoute("POST", "/api/agents/3/start", () =>
      json({ ...AGENT, status: "running" }),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    const a = await c.agents.start(3);
    expect(stub.last()?.method).toBe("POST");
    expect(stub.last()?.path).toBe("/api/agents/3/start");
    expect(a.status).toBe("running");
  });

  test("stop POSTs /api/agents/:id/stop and returns the Agent", async () => {
    stub.setRoute("POST", "/api/agents/3/stop", () =>
      json({ ...AGENT, status: "stopped" }),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    const a = await c.agents.stop(3);
    expect(stub.last()?.path).toBe("/api/agents/3/stop");
    expect(a.status).toBe("stopped");
  });

  test("restart POSTs /api/agents/:id/restart and returns {status}", async () => {
    stub.setRoute("POST", "/api/agents/3/restart", () =>
      json({ status: "restarted" }),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    const r = await c.agents.restart(3);
    expect(stub.last()?.path).toBe("/api/agents/3/restart");
    expect(r.status).toBe("restarted");
  });

  test("togglePause POSTs /api/agents/:id/pause and returns {paused}", async () => {
    stub.setRoute("POST", "/api/agents/3/pause", () => json({ paused: true }));
    const c = new AptevaClient({ baseURL: stub.url });
    const r = await c.agents.togglePause(3);
    expect(stub.last()?.method).toBe("POST");
    expect(stub.last()?.path).toBe("/api/agents/3/pause");
    expect(r.paused).toBe(true);
  });

  test("lifecycle calls carry the apiKey", async () => {
    stub.setRoute("POST", "/api/agents/3/start", () => json(AGENT));
    const c = new AptevaClient({ baseURL: stub.url, apiKey: "sk-life" });
    await c.agents.start(3);
    expect(stub.last()?.headers["authorization"]).toBe("Bearer sk-life");
  });
});

describe("agents namespace — proxied core routes", () => {
  test("event and control post through the server proxy", async () => {
    stub.setRoute("POST", "/api/agents/3/event", () =>
      json({ thread_id: "main", status: "queued" }),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    await c.agents.event(3, { message: "hello", context: { source: "test" } });
    expect(stub.last()?.path).toBe("/api/agents/3/event");
    expect(JSON.parse(stub.last()!.body)).toEqual({
      message: "hello",
      context: { source: "test" },
    });

    stub.setRoute("POST", "/api/agents/3/control", () => json({ ok: true }));
    const r = await c.agents.control<{ ok: boolean }>(3, { action: "wake" });
    expect(stub.last()?.path).toBe("/api/agents/3/control");
    expect(r.ok).toBe(true);
  });

  test("events opens /api/agents/:id/events as SSE", () => {
    const c = new AptevaClient({ baseURL: "https://x.example.com", apiKey: "sk-core" });
    const seen: unknown[] = [];
    const sub = c.agents.events(3, (event) => seen.push(event), { EventSource: FakeES });
    const es = FakeEventSource.last!;
    expect(es.url).toBe("https://x.example.com/api/agents/3/events?api_key=sk-core");
    expect(es.withCredentials).toBe(true);
    es.emitMessage('{"type":"event.received","thread_id":"main"}');
    expect(seen).toEqual([{ type: "event.received", thread_id: "main" }]);
    sub.close();
    expect(es.closed).toBe(true);
  });
});
