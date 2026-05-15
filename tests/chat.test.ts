import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AptevaClient } from "../src";
import type { ChatMessage, EventSourceCtor, EventSourceLike, StreamFrame } from "../src";
import { startStubServer, json, type StubServer } from "./stub-server";

let stub: StubServer;
beforeEach(() => {
  stub = startStubServer();
});
afterEach(async () => {
  await stub.stop();
});

const CHAT = {
  id: "chat-1",
  instance_id: 5,
  title: "Support",
  created_at: "2026-05-14T08:00:00Z",
  updated_at: "2026-05-14T08:00:00Z",
};

const MSG = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 1,
  chat_id: "chat-1",
  role: "user",
  content: "hi",
  status: "final",
  created_at: "2026-05-14T08:00:01Z",
  components: [],
  ...over,
});

describe("chat namespace — reads + writes", () => {
  test("list hits /chats with instance_id", async () => {
    stub.setRoute("GET", "/api/apps/channel-chat/chats", () => json([CHAT]));
    const c = new AptevaClient({ baseURL: stub.url });
    const chats = await c.chat.list(5);
    expect(chats[0]?.id).toBe("chat-1");
    expect(new URL(stub.last()!.url).searchParams.get("instance_id")).toBe("5");
  });

  test("create posts agent_id + title to /chats", async () => {
    stub.setRoute("POST", "/api/apps/channel-chat/chats", () => json(CHAT));
    const c = new AptevaClient({ baseURL: stub.url });
    await c.chat.create(5, "Support");
    expect(stub.last()?.path).toBe("/api/apps/channel-chat/chats");
    expect(JSON.parse(stub.last()!.body)).toEqual({ agent_id: 5, title: "Support" });
  });

  test("messages builds since + limit query, defaults since=0", async () => {
    stub.setRoute("GET", "/api/apps/channel-chat/messages", () => json([MSG()]));
    const c = new AptevaClient({ baseURL: stub.url });

    await c.chat.messages("chat-1");
    let u = new URL(stub.last()!.url);
    expect(u.searchParams.get("chat_id")).toBe("chat-1");
    expect(u.searchParams.get("since")).toBe("0");
    expect(u.searchParams.has("limit")).toBe(false);

    await c.chat.messages("chat-1", { since: 42, limit: 100 });
    u = new URL(stub.last()!.url);
    expect(u.searchParams.get("since")).toBe("42");
    expect(u.searchParams.get("limit")).toBe("100");
  });

  test("send posts content to /messages with chat_id query", async () => {
    stub.setRoute("POST", "/api/apps/channel-chat/messages", () =>
      json(MSG({ id: 7, content: "hello" })),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    const m = await c.chat.send("chat-1", "hello");
    expect(m.id).toBe(7);
    expect(new URL(stub.last()!.url).searchParams.get("chat_id")).toBe("chat-1");
    expect(JSON.parse(stub.last()!.body)).toEqual({ content: "hello" });
  });

  test("apiKey carries through to chat routes", async () => {
    stub.setRoute("GET", "/api/apps/channel-chat/chats", () => json([]));
    const c = new AptevaClient({ baseURL: stub.url, apiKey: "sk-c" });
    await c.chat.list(5);
    expect(stub.last()?.headers["authorization"]).toBe("Bearer sk-c");
  });
});

// --- chat.stream() frame discrimination, with an injected EventSource ---

class FakeEventSource implements EventSourceLike {
  static last: FakeEventSource | undefined;
  url: string;
  closed = false;
  listeners: Record<string, Array<(ev: unknown) => void>> = {};
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  close() {
    this.closed = true;
  }
  // Emit a frame on a specific SSE event name. Default = "message".
  emit(data: string, type: string = "message") {
    for (const fn of this.listeners[type] ?? []) fn({ data });
  }
}
const FakeES = FakeEventSource as unknown as EventSourceCtor;

describe("chat.stream() — frame discrimination", () => {
  test("opens the stream at the channel-chat SSE path", () => {
    const c = new AptevaClient({ baseURL: "https://x.example.com" });
    const sub = c.chat.stream("chat-1", { since: 9, EventSource: FakeES });
    expect(FakeEventSource.last!.url).toContain(
      "/api/apps/channel-chat/stream?chat_id=chat-1&since=9",
    );
    sub.close();
    expect(FakeEventSource.last!.closed).toBe(true);
  });

  test("full ChatMessage rows go to onMessage", () => {
    const c = new AptevaClient({ baseURL: "https://x.example.com" });
    const messages: ChatMessage[] = [];
    c.chat.stream("chat-1", { onMessage: (m) => messages.push(m), EventSource: FakeES });
    FakeEventSource.last!.emit(
      JSON.stringify(MSG({ id: 3, role: "agent", content: "done", status: "final" })),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("agent");
  });

  test("stream frames arrive on the named 'stream' SSE event", () => {
    const c = new AptevaClient({ baseURL: "https://x.example.com" });
    const deltas: StreamFrame[] = [];
    c.chat.stream("chat-1", { onDelta: (d) => deltas.push(d), EventSource: FakeES });
    const es = FakeEventSource.last!;
    // Real server emits StreamFrames as `event: stream\ndata: ...`,
    // not on the default channel — emit() defaults to "message", so
    // pass "stream" explicitly to exercise the named-event path.
    es.emit(
      JSON.stringify({
        type: "stream",
        chat_id: "chat-1",
        thread_id: "t1",
        call_id: "c1",
        text: "hel",
        done: false,
        created_at: "2026-05-14T08:00:02Z",
      }),
      "stream",
    );
    es.emit(
      JSON.stringify({
        type: "stream",
        chat_id: "chat-1",
        thread_id: "t1",
        call_id: "c1",
        text: "lo",
        done: true,
        created_at: "2026-05-14T08:00:03Z",
      }),
      "stream",
    );
    expect(deltas.map((d) => d.text)).toEqual(["hel", "lo"]);
    expect(deltas[1]?.done).toBe(true);
  });

  test("registers listeners for BOTH 'message' and 'stream' event names", () => {
    // Regression guard for the bug where chat.stream only listened
    // for default-event frames and silently dropped every stream
    // frame the server emitted as `event: stream`.
    const c = new AptevaClient({ baseURL: "https://x.example.com" });
    c.chat.stream("chat-1", { onDelta: () => {}, EventSource: FakeES });
    const es = FakeEventSource.last!;
    expect(Object.keys(es.listeners).sort()).toEqual(["message", "stream"]);
  });

  test("interleaved frames route to the right handler", () => {
    const c = new AptevaClient({ baseURL: "https://x.example.com" });
    const messages: ChatMessage[] = [];
    const deltas: StreamFrame[] = [];
    c.chat.stream("chat-1", {
      onMessage: (m) => messages.push(m),
      onDelta: (d) => deltas.push(d),
      EventSource: FakeES,
    });
    const es = FakeEventSource.last!;
    es.emit(JSON.stringify(MSG({ id: 1, role: "user", content: "hi" })));
    es.emit(JSON.stringify({ type: "stream", chat_id: "chat-1", thread_id: "t", call_id: "c", text: "h", done: false, created_at: "" }), "stream");
    es.emit(JSON.stringify({ type: "stream", chat_id: "chat-1", thread_id: "t", call_id: "c", text: "i", done: true, created_at: "" }), "stream");
    es.emit(JSON.stringify(MSG({ id: 2, role: "agent", content: "hi", status: "final" })));
    expect(messages.map((m) => m.id)).toEqual([1, 2]);
    expect(deltas.map((d) => d.text)).toEqual(["h", "i"]);
  });

  test("omitting a handler is safe (no throw)", () => {
    const c = new AptevaClient({ baseURL: "https://x.example.com" });
    // Only onDelta wired — a ChatMessage frame must not throw.
    c.chat.stream("chat-1", { onDelta: () => {}, EventSource: FakeES });
    expect(() =>
      FakeEventSource.last!.emit(JSON.stringify(MSG())),
    ).not.toThrow();
  });
});
