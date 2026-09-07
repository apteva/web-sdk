import { describe, expect, test } from "bun:test";
import { AptevaClient } from "../src";
import type { EventSourceLike, SSEEventMetadata } from "../src";

const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await delay();
  expect(predicate()).toBe(true);
}
function sse(text: string) {
  return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
}

describe("request cancellation", () => {
  test.each([0, 30_000])("caller cancellation survives timeoutMs=%i", async timeoutMs => {
    const client = new AptevaClient({ baseURL: "https://example.com", timeoutMs,
      fetch: (async (_url, init) => new Promise((_resolve, reject) => {
        if (init!.signal!.aborted) reject(init!.signal!.reason);
        else init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      })) as typeof fetch,
    });
    const controller = new AbortController();
    const request = client.app("example").tool("send", {}, { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toThrow("request aborted");
  });

  test("timeout remains active while reading the response body", async () => {
    const client = new AptevaClient({ baseURL: "https://example.com", timeoutMs: 10,
      fetch: (async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
        },
      }))) as typeof fetch,
    });
    await expect(client.app("example").get("/slow")).rejects.toThrow("timeout");
  });
});

describe("host-owned token renewal", () => {
  test("concurrent 401s refresh once and never replay writes", async () => {
    let refreshes = 0;
    const tokens: string[] = [];
    const client = new AptevaClient({ baseURL: "https://example.com", accessToken: "old",
      refreshAccessToken: async () => { refreshes++; await delay(10); return "new"; },
      fetch: (async (_url, init) => {
        const token = new Headers(init?.headers).get("Authorization")!;
        tokens.push(token);
        return token === "Bearer old" ? new Response("expired", { status: 401 }) : Response.json({ ok: true });
      }) as typeof fetch,
    });
    const results = await Promise.allSettled([
      client.app("example").post("/send", {}), client.app("example").tool("send", {}),
    ]);
    expect(results.every(result => result.status === "rejected")).toBe(true);
    expect(refreshes).toBe(1);
    expect(tokens).toEqual(["Bearer old", "Bearer old"]);
    await client.app("example").get("/items");
    expect(tokens[2]).toBe("Bearer new");
  });

  test("late refresh does not undo logout or a newer login", async () => {
    let finish!: (token: string) => void;
    const client = new AptevaClient({ baseURL: "", accessToken: "old",
      refreshAccessToken: () => new Promise(resolve => { finish = resolve; }),
    });
    const refreshing = client.refreshAccessToken();
    await until(() => Boolean(finish));
    client.setAccessToken(undefined);
    finish("late-token");
    expect(await refreshing).toBe(false);
    expect(client.getAccessToken()).toBeUndefined();
  });

  test("failed refresh keeps the original credential and 401", async () => {
    const client = new AptevaClient({ baseURL: "https://example.com", accessToken: "old", apiKey: "private",
      refreshAccessToken: async () => undefined,
      fetch: (async (_input: RequestInfo | URL) => new Response("expired", { status: 401 })) as typeof fetch,
    });
    await expect(client.app("example").post("/send", {})).rejects.toThrow("401");
    expect(client.getAccessToken()).toBe("old");
  });
});

describe("scoped resumable subscriptions", () => {
  test("reconnect carries cursor, routing and live auth; explicit IDs dedupe", async () => {
    const requests: Array<{ url: URL; headers: Headers }> = [];
    const rows: number[] = [];
    const metadata: SSEEventMetadata[] = [];
    const client = new AptevaClient({ baseURL: "https://example.com", accessToken: "old",
      fetch: (async (url, init) => {
        requests.push({ url: new URL(String(url)), headers: new Headers(init?.headers) });
        if (requests.length === 1) return sse('id: 1\r\nevent: row\r\ndata: {"n":1}\r\n\r\n');
        return sse('id: 1\ndata: {"n":1}\n\nid: 2\ndata: {"n":2}\n\n');
      }) as typeof fetch,
    });
    const controller = new AbortController();
    const handle = client.app("example", { projectId: "p", installId: 9 }).subscribe<{ n: number }>("/events", (row, meta) => {
      rows.push(row.n); metadata.push(meta);
      client.setAccessToken("new");
      if (row.n === 2) controller.abort();
    }, { signal: controller.signal, reconnectDelayMs: 1, cursorParam: "since_id", deduplicate: true, eventTypes: ["row", "message"] });
    try {
      await until(() => rows.length === 2);
      expect(rows).toEqual([1, 2]);
      expect(metadata).toEqual([{ event: "row", id: "1" }, { event: "message", id: "2" }]);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.headers.get("Last-Event-ID")).toBe("1");
      expect(requests[1]!.headers.get("Authorization")).toBe("Bearer new");
      expect(requests[1]!.url.searchParams.get("since_id")).toBe("1");
      expect(requests.every(r => r.url.searchParams.get("project_id") === "p" && r.url.searchParams.get("install_id") === "9")).toBe(true);
      expect(requests.every(r => !r.url.searchParams.has("api_key"))).toBe(true);
    } finally { handle.close(); }
  });

  test("handles chunked CRLF, UTF-8, empty IDs, malformed JSON and unterminated frames", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('id: initial\r\ndata: {"n":"é"}\r\n\r\nid:\rdata: {"n":"reset"}\r\rid: bad\ndata: nope\n\ndata: {"n":"lost"}');
    let calls = 0;
    const metas: SSEEventMetadata[] = [];
    const rows: string[] = [];
    const client = new AptevaClient({ baseURL: "https://example.com", accessToken: "token",
      fetch: (async (_url, init) => {
        calls++;
        if (calls > 1) {
          expect(new Headers(init?.headers).get("Last-Event-ID")).toBe("bad");
          return new Response(null, { status: 204 });
        }
        return new Response(new ReadableStream({ start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        } }));
      }) as typeof fetch,
    });
    const handle = client.app("example").subscribe<{ n: string }>("/events", (row, meta) => {
      rows.push(row.n); metas.push(meta);
    }, { reconnectDelayMs: 1 });
    try {
      await until(() => calls === 2);
      expect(rows).toEqual(["é", "reset"]);
      expect(metas.map(m => m.id)).toEqual(["initial", undefined]);
    } finally { handle.close(); }
  });

  test("deduplication is opt-in and bounded, and never discards ID-less updates", async () => {
    const rows: number[] = [];
    const client = new AptevaClient({ baseURL: "https://example.com", accessToken: "t",
      fetch: (async (_input: RequestInfo | URL) => sse('id: 1\ndata: 1\n\nid: 2\ndata: 2\n\nid: 1\ndata: 1\n\ndata: 3\n\n')) as typeof fetch,
    });
    const controller = new AbortController();
    const handle = client.app("example").subscribe<number>("/events", n => {
      rows.push(n); if (n === 3) controller.abort();
    }, { deduplicate: true, deduplicationWindow: 1, signal: controller.signal });
    try { await until(() => rows.length === 4); expect(rows).toEqual([1, 2, 1, 3]); }
    finally { handle.close(); }
  });

  test("401 renews once, then a second rejection closes instead of looping", async () => {
    let calls = 0, refreshes = 0, errors = 0;
    const client = new AptevaClient({ baseURL: "https://example.com", accessToken: "old",
      refreshAccessToken: async () => `new-${++refreshes}`,
      fetch: (async (_input: RequestInfo | URL) => { calls++; return new Response("no", { status: 401 }); }) as typeof fetch,
    });
    const handle = client.app("example").subscribe("/events", () => {}, {
      reconnectDelayMs: 1, onError: () => errors++,
    });
    try {
      await until(() => errors === 2); await delay(10);
      expect(calls).toBe(2); expect(refreshes).toBe(1);
    } finally { handle.close(); }
  });

  test("aborting a pending reconnect stops future requests", async () => {
    let calls = 0, errors = 0;
    const client = new AptevaClient({ baseURL: "https://example.com", accessToken: "t",
      fetch: (async (_input: RequestInfo | URL) => { calls++; return sse(""); }) as typeof fetch,
    });
    const controller = new AbortController();
    const handle = client.app("example").subscribe("/events", () => {}, {
      reconnectDelayMs: 20, signal: controller.signal, onError: () => errors++,
    });
    try {
      await until(() => errors === 1); controller.abort(); await delay(30);
      expect(calls).toBe(1);
    } finally { handle.close(); }
  });

  test("native streams honor scope and abort, including pre-aborted signals", () => {
    let opened = 0, closed = 0, url = "";
    class FakeSource implements EventSourceLike {
      constructor(value: string) { opened++; url = value; }
      addEventListener() {}
      close() { closed++; }
    }
    const client = new AptevaClient({ baseURL: "https://example.com" });
    const controller = new AbortController();
    const handle = client.app("example", { projectId: "p", installId: 4 }).subscribe("/events", () => {}, {
      EventSource: FakeSource, signal: controller.signal,
    });
    expect(new URL(url).search).toBe("?project_id=p&install_id=4");
    controller.abort(); handle.close();
    client.app("example").subscribe("/events", () => {}, { EventSource: FakeSource, signal: controller.signal });
    expect(opened).toBe(1); expect(closed).toBe(1);
  });
});
