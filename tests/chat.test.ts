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
  agent_id: 5,
  instance_id: 5,
  agent_ids: [5],
  project_id: "project-1",
  kind: "direct",
  title: "Support",
  directive: "",
  created_at: "2026-05-14T08:00:00Z",
  updated_at: "2026-05-14T08:00:00Z",
};

describe("delegated browser credentials", () => {
  test("trusted client mints a subject-bound browser token", async () => {
    stub.setRoute("POST", "/api/auth/delegated-users", () => json({
      access_token: "uk_browser",
      token_type: "Bearer",
      expires_in: 3600,
      expires_at: "2026-05-14T09:00:00Z",
      key_prefix: "uk_browser",
      project_id: "project-1",
      allowed_agent_ids: [5],
      subject: { type: "website_user", id: "customer-123" },
    }));
    const c = new AptevaClient({ baseURL: stub.url, apiKey: "sk-private" });

    const token = await c.delegatedUsers.create({
      projectId: "project-1",
      subjectType: "website_user",
      subjectId: "customer-123",
      agentId: 5,
      allowedOrigins: ["https://customer.example"],
      conversationDirective: "Help with plans.",
      expiresIn: 3600,
    });

    expect(token.access_token).toBe("uk_browser");
    expect(stub.last()?.headers.authorization).toBe("Bearer sk-private");
    expect(JSON.parse(stub.last()!.body)).toEqual({
      project_id: "project-1",
      subject_type: "website_user",
      subject_id: "customer-123",
      agent_id: 5,
      allowed_origins: ["https://customer.example"],
      conversation_directive: "Help with plans.",
      expires_in: 3600,
    });
  });
});

const MSG = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 1,
  chat_id: "chat-1",
  role: "user",
  content: "hi",
  status: "final",
  created_at: "2026-05-14T08:00:01Z",
  components: [],
  attachments: [],
  ...over,
});

describe("chat namespace — reads + writes", () => {
  test("list hits /chats with agent_id", async () => {
    stub.setRoute("GET", "/api/apps/channel-chat/chats", () => json([CHAT]));
    const c = new AptevaClient({ baseURL: stub.url });
    const chats = await c.chat.list(5);
    expect(chats[0]?.id).toBe("chat-1");
    expect(new URL(stub.last()!.url).searchParams.get("agent_id")).toBe("5");
    expect(new URL(stub.last()!.url).searchParams.has("instance_id")).toBe(false);
  });

  test("create posts agent_id + title to /chats", async () => {
    stub.setRoute("POST", "/api/apps/channel-chat/chats", () => json(CHAT));
    const c = new AptevaClient({ baseURL: stub.url });
    await c.chat.create(5, "Support");
    expect(stub.last()?.path).toBe("/api/apps/channel-chat/chats");
    expect(JSON.parse(stub.last()!.body)).toEqual({ agent_id: 5, title: "Support" });
  });

  test("create accepts a durable per-conversation directive", async () => {
    stub.setRoute("POST", "/api/apps/channel-chat/chats", () =>
      json({ ...CHAT, directive: "Help with pricing." }),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    const chat = await c.chat.create(5, {
      title: "Website support",
      directive: "Help with pricing.",
    });
    expect(chat.agent_id).toBe(5);
    expect(chat.directive).toBe("Help with pricing.");
    expect(JSON.parse(stub.last()!.body)).toEqual({
      agent_id: 5,
      title: "Website support",
      directive: "Help with pricing.",
    });
  });

  test("createOrResume sends only browser-safe conversation fields", async () => {
    stub.setRoute("POST", "/api/apps/channel-chat/chats", () =>
      json({ ...CHAT, conversation_key: "support", created: false }),
    );
    const c = new AptevaClient({ baseURL: stub.url, apiKey: "uk_browser" });
    const chat = await c.chat.createOrResume(5, {
      title: "Customer support",
      conversationKey: "support",
    });

    expect(chat.created).toBe(false);
    expect(JSON.parse(stub.last()!.body)).toEqual({
      agent_id: 5,
      title: "Customer support",
      conversation_key: "support",
    });
    expect(stub.last()?.headers.authorization).toBe("Bearer uk_browser");
  });

  test("get reads one subject-authorized conversation", async () => {
    stub.setRoute("GET", "/api/apps/channel-chat/chats/chat-1", () => json(CHAT));
    const c = new AptevaClient({ baseURL: stub.url, apiKey: "uk_browser" });
    expect((await c.chat.get("chat-1")).id).toBe("chat-1");
  });

  test("update patches title, directive, and archive state by conversation id", async () => {
    stub.setRoute("PATCH", "/api/apps/channel-chat/chats/chat-1", () =>
      json({ ...CHAT, title: "Enterprise", directive: "Annual plans only." }),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    const chat = await c.chat.update("chat-1", {
      title: "Enterprise",
      directive: "Annual plans only.",
      archived: false,
    });
    expect(chat.directive).toBe("Annual plans only.");
    expect(stub.last()?.path).toBe("/api/apps/channel-chat/chats/chat-1");
    expect(JSON.parse(stub.last()!.body)).toEqual({
      title: "Enterprise",
      directive: "Annual plans only.",
      archived: false,
    });
  });

  test("update preserves an empty directive so callers can clear it", async () => {
    stub.setRoute("PATCH", "/api/apps/channel-chat/chats/chat-1", () => json(CHAT));
    const c = new AptevaClient({ baseURL: stub.url });
    await c.chat.update("chat-1", { directive: "" });
    expect(JSON.parse(stub.last()!.body)).toEqual({ directive: "" });
  });

  test("getOrCreate resumes the latest existing chat", async () => {
    stub.setRoute("GET", "/api/apps/channel-chat/chats", () => json([CHAT]));
    const c = new AptevaClient({ baseURL: stub.url });
    const chat = await c.chat.getOrCreate(5, "Ignored");
    expect(chat.id).toBe("chat-1");
    expect(stub.all()).toHaveLength(1);
  });

  test("getOrCreate creates a chat only when none exists", async () => {
    stub.setRoute("GET", "/api/apps/channel-chat/chats", () => json([]));
    stub.setRoute("POST", "/api/apps/channel-chat/chats", () => json(CHAT));
    const c = new AptevaClient({ baseURL: stub.url });
    const chat = await c.chat.getOrCreate(5, "Support");
    expect(chat.id).toBe("chat-1");
    expect(stub.all().map((request) => request.method)).toEqual(["GET", "POST"]);
  });

  test("getOrCreate deduplicates concurrent resolutions for one agent", async () => {
    stub.setRoute("GET", "/api/apps/channel-chat/chats", () => json([]));
    stub.setRoute("POST", "/api/apps/channel-chat/chats", () => json(CHAT));
    const c = new AptevaClient({ baseURL: stub.url });

    const [first, second] = await Promise.all([
      c.chat.getOrCreate(5, "Support"),
      c.chat.getOrCreate(5, "Support"),
    ]);

    expect(first.id).toBe("chat-1");
    expect(second.id).toBe("chat-1");
    expect(stub.all().map((request) => request.method)).toEqual(["GET", "POST"]);
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

  test("messages.list is the recommended alias", async () => {
    stub.setRoute("GET", "/api/apps/channel-chat/messages", () => json([MSG()]));
    const c = new AptevaClient({ baseURL: stub.url });
    const messages = await c.chat.messages.list("chat-1", { since: 3 });
    expect(messages).toHaveLength(1);
    expect(new URL(stub.last()!.url).searchParams.get("since")).toBe("3");
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

  test("send supports object input with an idempotency key", async () => {
    stub.setRoute("POST", "/api/apps/channel-chat/messages", () =>
      json(MSG({ id: 9, content: "hello" })),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    await c.chat.send("chat-1", {
      content: "hello",
      clientMessageId: "site-session-42-message-1",
    });
    expect(JSON.parse(stub.last()!.body)).toEqual({
      content: "hello",
      client_message_id: "site-session-42-message-1",
    });
  });

  test("messages.send and markSeen expose delegated-safe operations", async () => {
    stub.setRoute("POST", "/api/apps/channel-chat/messages", () => json(MSG({ id: 12 })));
    stub.setRoute("POST", "/api/apps/channel-chat/seen", () => json({ last_seen_id: 12 }));
    const c = new AptevaClient({ baseURL: stub.url, apiKey: "uk_browser" });
    await c.chat.messages.send("chat-1", {
      content: "hello",
      clientMessageId: "customer-123:msg-42",
    });
    expect(JSON.parse(stub.last()!.body)).toEqual({
      content: "hello",
      client_message_id: "customer-123:msg-42",
    });
    expect((await c.chat.markSeen("chat-1", 12)).last_seen_id).toBe(12);
  });

  test("send posts image attachments and supports an attachment-only turn", async () => {
    stub.setRoute("POST", "/api/apps/channel-chat/messages", () =>
      json(MSG({ id: 8, content: "", attachments: [{ type: "image", data_url: "data:image/png;base64,aQ==" }] })),
    );
    const c = new AptevaClient({ baseURL: stub.url });
    const attachment = {
      id: "image-1",
      type: "image" as const,
      data_url: "data:image/png;base64,aQ==",
      name: "pixel.png",
      mime_type: "image/png",
      size: 1,
    };
    const message = await c.chat.send("chat-1", "", {
      attachments: [attachment],
      clientMessageId: "client-1",
    });

    expect(message.attachments).toHaveLength(1);
    expect(JSON.parse(stub.last()!.body)).toEqual({
      content: "",
      attachments: [attachment],
      client_message_id: "client-1",
    });
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
  test("API-key streams use an Authorization header and parse named SSE events", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let requestURL = "";
    let authorization: string | null = null;
    const encoder = new TextEncoder();
    const messages: ChatMessage[] = [];
    const deltas: StreamFrame[] = [];
    let opens = 0;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requestURL = String(input);
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const c = new AptevaClient({
      baseURL: "https://x.example.com",
      apiKey: "sk-private",
      fetch: fetchImpl,
    });

    const handle = c.chat.stream("chat-1", {
      since: 4,
      onOpen: () => opens++,
      onMessage: (message) => messages.push(message),
      onDelta: (frame) => deltas.push(frame),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    bodyController!.enqueue(encoder.encode(
      `: connected\n\nevent: stream\ndata: ${JSON.stringify({
        type: "stream",
        chat_id: "chat-1",
        thread_id: "t1",
        call_id: "c1",
        text: "hello",
        done: false,
        created_at: "2026-05-14T08:00:02Z",
      })}\n\ndata: ${JSON.stringify(MSG({ id: 5, role: "agent", content: "hello" }))}\n\n`,
    ));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(opens).toBe(1);
    expect(String(authorization)).toBe("Bearer sk-private");
    expect(requestURL).toContain("chat_id=chat-1&since=4");
    expect(requestURL).not.toContain("api_key");
    expect(deltas.map((frame) => frame.text)).toEqual(["hello"]);
    expect(messages.map((message) => message.id)).toEqual([5]);
    handle.close();
  });

  test("access-token streams omit cookies and stop when their signal aborts", async () => {
    let requestCredentials: RequestCredentials | undefined;
    let requestSignal: AbortSignal | null | undefined;
    let authorization: string | null = null;
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requestCredentials = init?.credentials;
      requestSignal = init?.signal;
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(new ReadableStream<Uint8Array>(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const c = new AptevaClient({
      baseURL: "https://x.example.com",
      accessToken: "opaque-application-user-token",
      fetch: fetchImpl,
    });
    const controller = new AbortController();
    c.chat.stream("chat-1", { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestCredentials).toBe("omit");
    expect(String(authorization)).toBe("Bearer opaque-application-user-token");
    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
  });

  test("access tokens are never put in an EventSource query string", async () => {
    let usedFetch = false;
    const fetchImpl = (async () => {
      usedFetch = true;
      return new Response(new ReadableStream<Uint8Array>(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const c = new AptevaClient({
      baseURL: "https://x.example.com",
      apiKey: "sk-fallback",
      accessToken: "opaque-application-user-token",
      fetch: fetchImpl,
    });

    const handle = c.chat.stream("chat-1", { EventSource: FakeES });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(usedFetch).toBe(true);
    const url = c.sseURL("/api/apps/channel-chat/stream");
    expect(url).not.toContain("opaque-application-user-token");
    expect(url).not.toContain("sk-fallback");
    handle.close();
  });

  test("reports stream open events", () => {
    const c = new AptevaClient({ baseURL: "https://x.example.com" });
    let opens = 0;
    c.chat.stream("chat-1", { onOpen: () => opens++, EventSource: FakeES });
    FakeEventSource.last!.emit("", "open");
    expect(opens).toBe(1);
  });

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
