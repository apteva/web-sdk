import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AptevaClient } from "../src";
import type { EventSourceCtor, EventSourceLike, TelemetryEvent } from "../src";
import { startStubServer, json, type StubServer } from "./stub-server";

let stub: StubServer;
beforeEach(() => {
  stub = startStubServer();
});
afterEach(async () => {
  await stub.stop();
});

describe("telemetry namespace — reads", () => {
  test("query builds the right query string", async () => {
    stub.setRoute("GET", "/api/telemetry", () => json([]));
    const c = new AptevaClient({ baseURL: stub.url });
    await c.telemetry.query({
      agentId: 7,
      type: "tool.call",
      threadId: "t9",
      since: "2026-05-14T00:00:00Z",
      limit: 100,
    });
    const u = new URL(stub.last()!.url);
    expect(u.pathname).toBe("/api/telemetry");
    expect(u.searchParams.get("instance_id")).toBe("7");
    expect(u.searchParams.get("type")).toBe("tool.call");
    expect(u.searchParams.get("thread_id")).toBe("t9");
    expect(u.searchParams.get("since")).toBe("2026-05-14T00:00:00Z");
    expect(u.searchParams.get("limit")).toBe("100");
  });

  test("query omits optional params when not given", async () => {
    stub.setRoute("GET", "/api/telemetry", () => json([]));
    const c = new AptevaClient({ baseURL: stub.url });
    await c.telemetry.query({ agentId: 7 });
    const u = new URL(stub.last()!.url);
    expect(u.searchParams.get("instance_id")).toBe("7");
    expect(u.searchParams.has("type")).toBe(false);
    expect(u.searchParams.has("limit")).toBe(false);
  });

  test("timeline hits /api/telemetry/timeline with period", async () => {
    stub.setRoute("GET", "/api/telemetry/timeline", () => json([]));
    const c = new AptevaClient({ baseURL: stub.url });
    await c.telemetry.timeline(7, "7d");
    const u = new URL(stub.last()!.url);
    expect(u.pathname).toBe("/api/telemetry/timeline");
    expect(u.searchParams.get("instance_id")).toBe("7");
    expect(u.searchParams.get("period")).toBe("7d");
  });

  test("timeline defaults period to 24h", async () => {
    stub.setRoute("GET", "/api/telemetry/timeline", () => json([]));
    const c = new AptevaClient({ baseURL: stub.url });
    await c.telemetry.timeline(7);
    expect(new URL(stub.last()!.url).searchParams.get("period")).toBe("24h");
  });

  test("stats hits /api/telemetry/stats and returns the shape", async () => {
    stub.setRoute("GET", "/api/telemetry/stats", () =>
      json({
        total_events: 120,
        llm_calls: 40,
        total_tokens_in: 9000,
        total_tokens_out: 3000,
        total_cost: 0.42,
        avg_duration_ms: 850,
        threads_spawned: 3,
        threads_done: 2,
        tool_calls: 35,
        errors: 1,
      }),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    const s = await c.telemetry.stats(7, "1h");
    expect(s.llm_calls).toBe(40);
    expect(s.total_cost).toBe(0.42);
    expect(new URL(stub.last()!.url).searchParams.get("period")).toBe("1h");
  });
});

// --- subscribe() / telemetry.stream() with an injected fake EventSource ---

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
  // Test helpers
  emitMessage(data: string) {
    for (const fn of this.listeners["message"] ?? []) fn({ data });
  }
  emitError(err: unknown) {
    for (const fn of this.listeners["error"] ?? []) fn(err);
  }
}

const FakeES = FakeEventSource as unknown as EventSourceCtor;

describe("subscribe()", () => {
  test("opens an EventSource at the SSE URL with withCredentials", () => {
    const c = new AptevaClient({ baseURL: "https://x.example.com", apiKey: "sk-z" });
    const sub = c.subscribe("/api/telemetry/stream", { instance_id: 5 }, () => {}, {
      EventSource: FakeES,
    });
    const es = FakeEventSource.last!;
    expect(es.withCredentials).toBe(true);
    expect(es.url).toBe(
      "https://x.example.com/api/telemetry/stream?instance_id=5&api_key=sk-z",
    );
    sub.close();
    expect(es.closed).toBe(true);
  });

  test("parses message frames and drops malformed ones", () => {
    const c = new AptevaClient({ baseURL: "https://x.example.com" });
    const seen: unknown[] = [];
    c.subscribe<{ n: number }>("/api/x", undefined, (e) => seen.push(e), {
      EventSource: FakeES,
    });
    const es = FakeEventSource.last!;
    es.emitMessage('{"n":1}');
    es.emitMessage("not json");
    es.emitMessage("");
    es.emitMessage('{"n":2}');
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("forwards error events to opts.onError", () => {
    const c = new AptevaClient({ baseURL: "https://x.example.com" });
    let errSeen: unknown = null;
    c.subscribe("/api/x", undefined, () => {}, {
      EventSource: FakeES,
      onError: (e) => {
        errSeen = e;
      },
    });
    FakeEventSource.last!.emitError({ kind: "boom" });
    expect(errSeen).toEqual({ kind: "boom" });
  });

  test("throws when no EventSource is available", () => {
    const c = new AptevaClient({ baseURL: "https://x.example.com" });
    const saved = (globalThis as { EventSource?: unknown }).EventSource;
    delete (globalThis as { EventSource?: unknown }).EventSource;
    try {
      expect(() => c.subscribe("/api/x", undefined, () => {})).toThrow(
        /no EventSource available/,
      );
    } finally {
      if (saved !== undefined) {
        (globalThis as { EventSource?: unknown }).EventSource = saved;
      }
    }
  });
});

describe("telemetry.stream()", () => {
  test("streams telemetry events for an agent", () => {
    const c = new AptevaClient({ baseURL: "https://x.example.com" });
    const events: TelemetryEvent[] = [];
    const sub = c.telemetry.stream(9, (e) => events.push(e), { EventSource: FakeES });
    const es = FakeEventSource.last!;
    expect(es.url).toContain("/api/telemetry/stream?instance_id=9");

    es.emitMessage(
      JSON.stringify({
        id: "e1",
        instance_id: 9,
        thread_id: "t1",
        type: "tool.call",
        time: "2026-05-14T08:00:00Z",
        data: { tool: "search" },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool.call");
    expect(events[0]?.data).toEqual({ tool: "search" });
    sub.close();
    expect(es.closed).toBe(true);
  });

  test("normalizes a double-stringified data field", () => {
    const c = new AptevaClient({ baseURL: "https://x.example.com" });
    const events: TelemetryEvent[] = [];
    c.telemetry.stream(9, (e) => events.push(e), { EventSource: FakeES });
    // Server quirk: `data` arrives as a JSON string, not an object.
    FakeEventSource.last!.emitMessage(
      JSON.stringify({
        id: "e2",
        instance_id: 9,
        thread_id: "t1",
        type: "llm.done",
        time: "2026-05-14T08:00:01Z",
        data: JSON.stringify({ tokens_in: 100, tokens_out: 20 }),
      }),
    );
    expect(events[0]?.data).toEqual({ tokens_in: 100, tokens_out: 20 });
  });

  test("leaves data as-is when the inner string isn't JSON", () => {
    const c = new AptevaClient({ baseURL: "https://x.example.com" });
    const events: TelemetryEvent[] = [];
    c.telemetry.stream(9, (e) => events.push(e), { EventSource: FakeES });
    FakeEventSource.last!.emitMessage(
      JSON.stringify({
        id: "e3",
        instance_id: 9,
        thread_id: "t1",
        type: "mode.changed",
        time: "2026-05-14T08:00:02Z",
        data: "continuous",
      }),
    );
    // Public type says `data` is an object; this verifies the runtime
    // pass-through when the server sends a non-JSON inner string.
    expect(events[0]?.data as unknown).toBe("continuous");
  });
});
