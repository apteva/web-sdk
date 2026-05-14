import { AptevaError } from "./errors.js";
import type {
  Agent,
  AgentPauseResult,
  AgentRestartResult,
  AgentStatus,
  AptevaClientOptions,
  AuthStatus,
  ChannelInfo,
  Chat,
  ChatHistoryMessage,
  ChatMessage,
  ChatMessagesQuery,
  ChatStreamOptions,
  EventSourceCtor,
  MCPCallResponse,
  StreamFrame,
  StreamHandle,
  SubscribeOptions,
  TelemetryEvent,
  TelemetryPeriod,
  TelemetryQuery,
  TelemetryStats,
  Thread,
  TimelineBucket,
  User,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export class AptevaClient {
  private readonly baseURL: string;
  private apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onUnauthorized?: () => void;
  private readonly timeoutMs: number;

  constructor(opts: AptevaClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.onUnauthorized = opts.onUnauthorized;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // Swap the API key at runtime (e.g. after the user mints a fresh
  // one in settings). Pass undefined to fall back to cookie auth.
  setApiKey(key: string | undefined): void {
    this.apiKey = key;
  }

  getApiKey(): string | undefined {
    return this.apiKey;
  }

  // Auth surface. Maps 1:1 onto /api/auth/*. login() sets a cookie
  // on the server side that subsequent requests pick up automatically
  // when credentials: "include" is sent.
  readonly auth = {
    register: (email: string, password: string, name?: string) =>
      this.post<{ user: User }>("/api/auth/register", { email, password, name }),

    login: (email: string, password: string) =>
      this.post<User>("/api/auth/login", { email, password }),

    logout: () => this.post<void>("/api/auth/logout", {}),

    me: () => this.get<User>("/api/auth/me"),

    status: () => this.get<AuthStatus>("/api/auth/status"),

    changePassword: (current: string, next: string) =>
      this.post<void>("/api/auth/password", { current, next }),

    listKeys: () =>
      this.get<Array<{ id: number; name: string; created_at: string }>>(
        "/api/auth/keys",
      ),

    createKey: (name: string) =>
      this.post<{ id: number; key: string }>("/api/auth/keys", { name }),

    deleteKey: (id: number) => this.del<void>(`/api/auth/keys/${id}`),
  };

  // Agents surface. Maps onto /api/agents/* — the running apteva-core
  // child processes. (The server keeps /api/instances as an alias; the
  // SDK uses the /agents path exclusively.)
  readonly agents = {
    list: () => this.get<Agent[]>("/api/agents"),

    get: (id: number) => this.get<Agent>(`/api/agents/${id}`),

    status: (id: number) => this.get<AgentStatus>(`/api/agents/${id}/status`),

    threads: (id: number) => this.get<Thread[]>(`/api/agents/${id}/threads`),

    channels: (id: number) => this.get<ChannelInfo[]>(`/api/agents/${id}/channels`),

    chatHistory: (id: number, limit = 50) =>
      this.get<ChatHistoryMessage[]>(
        `/api/agents/${id}/chat-history?limit=${encodeURIComponent(String(limit))}`,
      ),

    // --- lifecycle ---

    // Spawn the agent's apteva-core process. Returns the updated Agent
    // (status flips to "running").
    start: (id: number) => this.post<Agent>(`/api/agents/${id}/start`, {}),

    // Terminate the agent's process. Returns the updated Agent.
    stop: (id: number) => this.post<Agent>(`/api/agents/${id}/stop`, {}),

    // Stop + start in one call.
    restart: (id: number) =>
      this.post<AgentRestartResult>(`/api/agents/${id}/restart`, {}),

    // Toggle the agent's paused state — pausing halts the thinking loop
    // without killing the process. This is a *toggle*: there's no
    // separate resume endpoint. The result reports the state after the
    // flip, so check `.paused` rather than assuming.
    togglePause: (id: number) =>
      this.post<AgentPauseResult>(`/api/agents/${id}/pause`, {}),
  };

  // Activity / telemetry surface. query/timeline/stats are plain reads;
  // stream() opens a live SSE feed (see subscribe() for the generic form).
  readonly telemetry = {
    // Filtered event read — GET /api/telemetry.
    query: (q: TelemetryQuery) => {
      const params = new URLSearchParams();
      params.set("instance_id", String(q.agentId));
      if (q.type) params.set("type", q.type);
      if (q.threadId) params.set("thread_id", q.threadId);
      if (q.since) params.set("since", q.since);
      if (q.limit !== undefined) params.set("limit", String(q.limit));
      return this.get<TelemetryEvent[]>(`/api/telemetry?${params.toString()}`);
    },

    // Time-bucketed aggregates — GET /api/telemetry/timeline.
    timeline: (agentId: number, period: TelemetryPeriod = "24h") =>
      this.get<TimelineBucket[]>(
        `/api/telemetry/timeline?instance_id=${agentId}&period=${period}`,
      ),

    // Window counters — GET /api/telemetry/stats.
    stats: (agentId: number, period: TelemetryPeriod = "24h") =>
      this.get<TelemetryStats>(
        `/api/telemetry/stats?instance_id=${agentId}&period=${period}`,
      ),

    // Live activity feed for one agent over SSE. Returns a handle —
    // call .close() to tear down. The server occasionally emits the
    // event's `data` field as a JSON-stringified string rather than an
    // object; this normalizes it so callers always see an object.
    stream: (
      agentId: number,
      onEvent: (event: TelemetryEvent) => void,
      opts?: SubscribeOptions,
    ): StreamHandle =>
      this.subscribe<TelemetryEvent>(
        "/api/telemetry/stream",
        { instance_id: agentId },
        (event) => {
          if (typeof event.data === "string") {
            try {
              event.data = JSON.parse(event.data);
            } catch {
              /* leave as-is */
            }
          }
          onEvent(event);
        },
        opts,
      ),
  };

  // Chat surface. Wraps the built-in `channel-chat` app at
  // /api/apps/channel-chat/*. One chat is bound to one agent; send()
  // posts a user message AND triggers the agent to respond, whose
  // reply streams back token-by-token over stream().
  readonly chat = {
    // List an agent's chats — GET /chats?instance_id=.
    list: (agentId: number) =>
      this.get<Chat[]>(
        `/api/apps/channel-chat/chats?instance_id=${agentId}`,
      ),

    // Create (or get the default) chat for an agent — POST /chats.
    create: (agentId: number, title?: string) =>
      this.post<Chat>("/api/apps/channel-chat/chats", {
        agent_id: agentId,
        title,
      }),

    // History — GET /messages. `since` is a message-id cursor (0 = start).
    messages: (chatId: string, query: ChatMessagesQuery = {}) => {
      const params = new URLSearchParams({ chat_id: chatId });
      params.set("since", String(query.since ?? 0));
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      return this.get<ChatMessage[]>(
        `/api/apps/channel-chat/messages?${params.toString()}`,
      );
    },

    // Send a user message — POST /messages. The server appends it and
    // forwards it to the agent's /event endpoint, so this one call both
    // records the message and triggers the agent's reply. Returns the
    // persisted user message row.
    send: (chatId: string, content: string) =>
      this.post<ChatMessage>(
        `/api/apps/channel-chat/messages?chat_id=${encodeURIComponent(chatId)}`,
        { content },
      ),

    // Live feed for one chat. The SSE stream interleaves two frame
    // shapes; this discriminates them so callers never see the raw
    // mixed stream:
    //   - full ChatMessage rows  → opts.onMessage
    //   - StreamFrame deltas (type:"stream") → opts.onDelta
    // Returns a StreamHandle — call .close() to stop.
    stream: (chatId: string, opts: ChatStreamOptions): StreamHandle =>
      this.subscribe<ChatMessage | StreamFrame>(
        "/api/apps/channel-chat/stream",
        { chat_id: chatId, since: opts.since ?? 0 },
        (frame) => {
          if ((frame as StreamFrame).type === "stream") {
            opts.onDelta?.(frame as StreamFrame);
          } else {
            opts.onMessage?.(frame as ChatMessage);
          }
        },
        { EventSource: opts.EventSource, onError: opts.onError },
      ),
  };

  // Build a handle for one installed app. The returned object knows
  // both the HTTP route surface (/api/apps/<name>/<route>) and the
  // MCP tool surface (/api/apps/<name>/mcp). T is the default return
  // type for typed route helpers — defaults to unknown so callers
  // either pass a per-call generic or stick to `unknown`.
  app<T = unknown>(name: string): AppHandle<T> {
    const base = `/api/apps/${encodeURIComponent(name)}`;
    return {
      name,
      get: <R = T>(path: string) => this.get<R>(base + path),
      post: <R = T>(path: string, body?: unknown) =>
        this.post<R>(base + path, body),
      put: <R = T>(path: string, body?: unknown) =>
        this.put<R>(base + path, body),
      patch: <R = T>(path: string, body?: unknown) =>
        this.patch<R>(base + path, body),
      del: <R = T>(path: string) => this.del<R>(base + path),
      tool: <R = T>(toolName: string, args: Record<string, unknown> = {}) =>
        this.callTool<R>(name, toolName, args),
      mcpURL: (queryParams?: Record<string, string>) => {
        const u = new URL(this.baseURL + base + "/mcp", "http://_");
        if (queryParams) {
          for (const [k, v] of Object.entries(queryParams)) {
            u.searchParams.set(k, v);
          }
        }
        return this.baseURL ? this.baseURL + u.pathname + u.search : u.pathname + u.search;
      },
    };
  }

  // Lower-level direct MCP call. Most callers should use
  // client.app("name").tool("name", args) which routes through this.
  async callTool<R>(
    appName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<R> {
    const path = `/api/apps/${encodeURIComponent(appName)}/mcp`;
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    } as const;
    const env = await this.post<MCPCallResponse<unknown>>(path, body);
    return unwrapMCP<R>(env);
  }

  // --- raw HTTP helpers (exposed so consumers can hit endpoints the
  // SDK doesn't yet wrap) ---

  get<R>(path: string, init?: RequestInit): Promise<R> {
    return this.request<R>("GET", path, undefined, init);
  }
  post<R>(path: string, body?: unknown, init?: RequestInit): Promise<R> {
    return this.request<R>("POST", path, body, init);
  }
  put<R>(path: string, body?: unknown, init?: RequestInit): Promise<R> {
    return this.request<R>("PUT", path, body, init);
  }
  patch<R>(path: string, body?: unknown, init?: RequestInit): Promise<R> {
    return this.request<R>("PATCH", path, body, init);
  }
  del<R>(path: string, init?: RequestInit): Promise<R> {
    return this.request<R>("DELETE", path, undefined, init);
  }

  // Build a fully-qualified URL for an SSE endpoint (EventSource can't
  // send custom headers, so an API key has to ride as ?api_key=).
  // Cookie auth works on same-origin without query-string fallback.
  sseURL(path: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(this.baseURL + path, "http://_");
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      }
    }
    if (this.apiKey && !url.searchParams.has("api_key")) {
      url.searchParams.set("api_key", this.apiKey);
    }
    return this.baseURL ? this.baseURL + url.pathname + url.search : url.pathname + url.search;
  }

  // Open a live SSE subscription. Generic over the event payload type;
  // each `message` frame's data is JSON-parsed and handed to onEvent.
  // Malformed frames are dropped silently — SSE is best-effort, and one
  // bad frame shouldn't kill the stream.
  //
  // Auth: EventSource can't set headers, so when an apiKey is configured
  // it rides as ?api_key= (via sseURL); cookie auth works same-origin
  // through withCredentials. Returns a StreamHandle — call .close().
  //
  // Node note: needs a global EventSource (Node 22+, browsers, Deno, Bun)
  // or an injected one via opts.EventSource.
  subscribe<E>(
    path: string,
    params: Record<string, string | number | undefined> | undefined,
    onEvent: (event: E) => void,
    opts?: SubscribeOptions,
  ): StreamHandle {
    const Ctor: EventSourceCtor | undefined =
      opts?.EventSource ??
      (globalThis as { EventSource?: EventSourceCtor }).EventSource;
    if (!Ctor) {
      throw new AptevaError(
        0,
        "no EventSource available — pass opts.EventSource (Node < 22 has no global EventSource)",
      );
    }
    const url = this.sseURL(path, params);
    const es = new Ctor(url, { withCredentials: true });

    es.addEventListener("message", (ev: unknown) => {
      const data = (ev as { data?: unknown })?.data;
      if (typeof data !== "string" || data === "") return;
      let parsed: E;
      try {
        parsed = JSON.parse(data) as E;
      } catch {
        return; // drop malformed frame
      }
      onEvent(parsed);
    });
    if (opts?.onError) {
      es.addEventListener("error", opts.onError);
    }

    return { close: () => es.close() };
  }

  // --- internals ---

  private async request<R>(
    method: string,
    path: string,
    body: unknown,
    init?: RequestInit,
  ): Promise<R> {
    const url = this.baseURL + path;
    const headers = new Headers(init?.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (this.apiKey && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }

    const ac = this.timeoutMs > 0 ? new AbortController() : undefined;
    const timer = ac
      ? setTimeout(() => ac.abort(), this.timeoutMs)
      : undefined;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        credentials: "include",
        ...init,
        headers,
        body: body === undefined ? init?.body : JSON.stringify(body),
        signal: ac?.signal ?? init?.signal,
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new AptevaError(0, `request timeout after ${this.timeoutMs}ms`);
      }
      throw new AptevaError(0, err instanceof Error ? err.message : String(err));
    }
    if (timer) clearTimeout(timer);

    if (res.status === 401) {
      this.onUnauthorized?.();
      const text = await readBody(res);
      throw new AptevaError(401, text || "unauthorized");
    }
    if (!res.ok) {
      const text = await readBody(res);
      throw new AptevaError(res.status, text || res.statusText);
    }

    const ct = res.headers.get("Content-Type") ?? "";
    if (res.status === 204) return undefined as R;
    if (ct.includes("application/json")) {
      return (await res.json()) as R;
    }
    return (await res.text()) as unknown as R;
  }
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// Strip the MCP JSON-RPC envelope so callers see the tool's natural
// return shape. Mirrors app-sdk/caller.go::CallAppResult. Three cases:
//   1. envelope.error  → throw AptevaError(-1, message, code)
//   2. envelope.result.content[0].text  → JSON.parse(text), return it
//   3. envelope has neither (the platform already short-circuited an
//      unwrapped response) → cast and return
export function unwrapMCP<R>(env: MCPCallResponse<unknown>): R {
  if (env && env.error) {
    throw new AptevaError(-1, env.error.message, env.error.code);
  }
  const text = env?.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    return env as unknown as R;
  }
  try {
    return JSON.parse(text) as R;
  } catch (err) {
    throw new AptevaError(
      -1,
      `MCP response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface AppHandle<TDefault = unknown> {
  readonly name: string;
  get<R = TDefault>(path: string): Promise<R>;
  post<R = TDefault>(path: string, body?: unknown): Promise<R>;
  put<R = TDefault>(path: string, body?: unknown): Promise<R>;
  patch<R = TDefault>(path: string, body?: unknown): Promise<R>;
  del<R = TDefault>(path: string): Promise<R>;
  tool<R = TDefault>(name: string, args?: Record<string, unknown>): Promise<R>;
  mcpURL(queryParams?: Record<string, string>): string;
}
