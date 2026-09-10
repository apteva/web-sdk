import { AuthSession } from "./auth-session.js";
import type { AuthLoginInput, AuthSignupInput } from "./auth-session.js";
import { loadAppFrontend, type LoadAppOptions, type LoadedAppFrontend } from "./frontend.js";
import { AptevaError } from "./errors.js";
import type { AppExtension, AppScope } from "./extensions.js";
import type { InstalledApp } from "./apps.js";
import type {
  Agent,
  AgentConfig,
  AgentCoreEvent,
  AgentCreateInput,
  AgentCreateResult,
  AgentDeleteResult,
  AgentPauseResult,
  AgentRestartResult,
  AgentStatus,
  AgentSystemMCPResult,
  AgentUpdateInput,
  AptevaClientOptions,
  AuthStatus,
  ChannelInfo,
  Chat,
  CreateChatOptions,
  CreateOrResumeChatOptions,
  ChatCreateResult,
  CreateDelegatedUserInput,
  DelegatedUserToken,
  ChatHistoryMessage,
  ChatMessage,
  ChatMessagesQuery,
  ChatSendInput,
  ChatSendOptions,
  ChatStreamOptions,
  EventSourceCtor,
  MCPCallResponse,
  Project,
  StreamFrame,
  StreamHandle,
  SubscribeOptions,
  SSEEventMetadata,
  TelemetryEvent,
  TelemetryPeriod,
  TelemetryQuery,
  TelemetryStats,
  Thread,
  TimelineBucket,
  UpdateChatOptions,
  User,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export class AptevaClient {
  private readonly baseURL: string;
  private apiKey?: string;
  private readonly appAuth?: AuthSession;
  private accessToken?: string;
  private readonly projectId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onUnauthorized?: () => void;
  private readonly timeoutMs: number;
  private readonly refreshTokenHook?: () => Promise<string | undefined>;
  private credentialRevision = 0;
  private pendingTokenRefresh?: Promise<boolean>;
  private readonly pendingChatResolutions = new Map<number, Promise<Chat>>();

  constructor(opts: AptevaClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.accessToken = opts.accessToken;
    this.projectId = opts.projectId?.trim() || undefined;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.onUnauthorized = opts.onUnauthorized;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.refreshTokenHook = opts.refreshAccessToken;
    if (opts.auth) {
      if (opts.apiKey || opts.accessToken || opts.refreshAccessToken) throw new Error("Configure auth without apiKey, accessToken or refreshAccessToken");
      this.appAuth = new AuthSession(this.baseURL, this.projectId || "", opts.auth, this.fetchImpl, token => {
        this.accessToken = token; this.credentialRevision++;
      });
    }
  }

  // Swap the API key at runtime. An accessToken, when configured, continues
  // to take precedence. Pass undefined to fall back to access-token/cookie auth.
  setApiKey(key: string | undefined): void {
    if (this.appAuth) throw new Error("Auth manages credentials; use auth.login/logout");
    this.apiKey = key;
    this.credentialRevision++;
  }

  getApiKey(): string | undefined {
    return this.apiKey;
  }

  // Swap an application-user bearer token after login or refresh. Tokens are
  // opaque to the SDK: no issuer-specific prefix or response type is required.
  // Pass undefined to fall back to apiKey, then cookie auth.
  setAccessToken(token: string | undefined): void {
    if (this.appAuth) throw new Error("Auth manages credentials; use auth.login/logout");
    this.accessToken = token;
    this.credentialRevision++;
  }

  getAccessToken(): string | undefined {
    return this.accessToken;
  }

  /** Refresh once for concurrent callers. Undefined leaves credentials unchanged. */
  async refreshAccessToken(): Promise<boolean> {
    if (this.appAuth) { await this.appAuth.token(true); return true; }
    if (!this.refreshTokenHook) return false;
    if (this.pendingTokenRefresh) return this.pendingTokenRefresh;
    const revision = this.credentialRevision;
    const refresh = Promise.resolve().then(() => this.refreshTokenHook!()).then((token) => {
      // A login/logout/token replacement while refreshing always wins.
      if (this.credentialRevision !== revision) return false;
      if (!token || token === this.accessToken) return false;
      this.setAccessToken(token);
      return true;
    });
    this.pendingTokenRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.pendingTokenRefresh === refresh) this.pendingTokenRefresh = undefined;
    }
  }

  private async renewAfterUnauthorized(revision: number): Promise<boolean> {
    if (revision !== this.credentialRevision) return Boolean(this.bearerToken());
    try {
      return await this.refreshAccessToken();
    } catch {
      // Preserve the original 401; callers can observe refresh errors by
      // invoking refreshAccessToken() directly or inside their own hook.
      return false;
    }
  }

  // Auth surface. Maps 1:1 onto /api/auth/*. login() sets a cookie
  // on the server side that subsequent requests pick up automatically
  // when credentials: "include" is sent.
  readonly auth = {
    register: (email: string | AuthSignupInput, password?: string, name?: string) => {
      if (this.appAuth) return this.appAuth.register(typeof email === "string" ? { email, password: password || "", displayName: name } : email);
      if (typeof email !== "string") throw new Error("Object signup requires auth configuration");
      return this.post<{ user: User; verification_required?: boolean }>("/api/auth/register", { email, password, name });
    },

    login: (email: string | AuthLoginInput, password?: string) => {
      if (this.appAuth) return this.appAuth.login(typeof email === "string" ? { email, password: password || "" } : email);
      if (typeof email !== "string") throw new Error("Object login requires auth configuration");
      return this.post<User>("/api/auth/login", { email, password });
    },

    logout: () => this.appAuth ? this.appAuth.logout() : this.post<void>("/api/auth/logout", {}),

    me: () => this.appAuth ? this.appAuth.me() : this.get<User>("/api/auth/me"),

    getSession: () => this.appAuth?.info(),

    refresh: async () => {
      if (!this.appAuth) throw new Error("Session refresh requires auth configuration");
      await this.appAuth.token(true); return this.appAuth.info();
    },

    status: (): Promise<AuthStatus> => this.appAuth
      ? Promise.resolve({ authenticated: Boolean(this.appAuth.info()), user: this.appAuth.info()?.user })
      : this.get<AuthStatus>("/api/auth/status"),

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

  readonly projects = {
    list: () => this.get<Project[]>("/api/projects"),
    get: (id: string) => this.get<Project>(`/api/projects/${encodeURIComponent(id)}`),
  };

  // Legacy trusted-backend surface for minting a short-lived, subject-bound
  // browser credential. New integrations should receive a generic token from
  // their identity flow and configure it through accessToken instead.
  /** @deprecated Prefer AptevaClient({ accessToken }). */
  readonly delegatedUsers = {
    create: (input: CreateDelegatedUserInput) =>
      this.post<DelegatedUserToken>("/api/auth/delegated-users", {
        project_id: input.projectId,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        agent_id: input.agentId,
        allowed_agent_ids: input.allowedAgentIds,
        allowed_origins: input.allowedOrigins,
        conversation_directive: input.conversationDirective,
        expires_in: input.expiresIn,
        rate_limit_per_minute: input.rateLimitPerMinute,
      }),
  };

  // Agents surface. Maps onto /api/agents/* — the running apteva-core
  // child processes. (The server keeps /api/instances as an alias; the
  // SDK uses the /agents path exclusively.)
  readonly agents = {
    list: () => this.get<Agent[]>("/api/agents"),

    create: (input: AgentCreateInput) =>
      this.post<AgentCreateResult>("/api/agents", input),

    get: (id: number) => this.get<Agent>(`/api/agents/${id}`),

    update: (id: number, input: AgentUpdateInput) =>
      this.put<Agent>(`/api/agents/${id}`, input),

    rename: (id: number, name: string) =>
      this.put<Agent>(`/api/agents/${id}`, { name }),

    delete: (id: number) =>
      this.del<AgentDeleteResult>(`/api/agents/${id}`),

    status: (id: number) => this.get<AgentStatus>(`/api/agents/${id}/status`),

    threads: (id: number) => this.get<Thread[]>(`/api/agents/${id}/threads`),

    channels: (id: number) => this.get<ChannelInfo[]>(`/api/agents/${id}/channels`),

    chatHistory: (id: number, limit = 50) =>
      this.get<ChatHistoryMessage[]>(
        `/api/agents/${id}/chat-history?limit=${encodeURIComponent(String(limit))}`,
      ),

    config: <R = AgentConfig>(id: number) =>
      this.get<R>(`/api/agents/${id}/config`),

    updateConfig: <R = AgentConfig>(id: number, config: AgentConfig) =>
      this.put<R>(`/api/agents/${id}/config`, config),

    systemMCP: (id: number, name: "channels" | "apteva-channels", enable: boolean) =>
      this.post<AgentSystemMCPResult>(`/api/agents/${id}/system-mcp`, {
        name,
        enable,
      }),

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

    // --- proxied core routes ---

    event: <R = unknown>(id: number, body: Record<string, unknown>) =>
      this.post<R>(`/api/agents/${id}/event`, body),

    control: <R = unknown>(id: number, body: Record<string, unknown>) =>
      this.post<R>(`/api/agents/${id}/control`, body),

    events: <E = AgentCoreEvent>(
      id: number,
      onEvent: (event: E, metadata: SSEEventMetadata) => void,
      opts?: SubscribeOptions,
    ): StreamHandle =>
      this.subscribe<E>(`/api/agents/${id}/events`, undefined, onEvent, opts),
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
    // List an agent's chats — GET /chats?agent_id=.
    list: (agentId: number) =>
      this.get<Chat[]>(
        `/api/apps/channel-chat/chats?agent_id=${agentId}`,
      ),

    get: (chatId: string) =>
      this.get<Chat>(
        `/api/apps/channel-chat/chats/${encodeURIComponent(chatId)}`,
      ),

    // Create a durable conversation for an agent. The string form is retained
    // for compatibility; object form adds a conversation-scoped directive.
    create: (agentId: number, options?: string | CreateChatOptions) => {
      const input = typeof options === "string" ? { title: options } : options ?? {};
      return this.post<Chat>("/api/apps/channel-chat/chats", {
        agent_id: agentId,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.directive !== undefined ? { directive: input.directive } : {}),
        ...(input.conversationKey !== undefined ? { conversation_key: input.conversationKey } : {}),
      });
    },

    // Atomic create/resume for a delegated website user. The uk- credential
    // supplies project, subject, allowed agent, and directive, so those values
    // are intentionally absent from this request body.
    createOrResume: (agentId: number, options: CreateOrResumeChatOptions) =>
      this.post<ChatCreateResult>("/api/apps/channel-chat/chats", {
        agent_id: agentId,
        ...(options.title !== undefined ? { title: options.title } : {}),
        conversation_key: options.conversationKey,
      }),

    // Update conversation metadata/instructions. Always address the Channel
    // Chat conversation id; thread_id is informational and must not be used.
    update: (chatId: string, options: UpdateChatOptions) =>
      this.patch<Chat>(
        `/api/apps/channel-chat/chats/${encodeURIComponent(chatId)}`,
        {
          ...(options.title !== undefined ? { title: options.title } : {}),
          ...(options.directive !== undefined ? { directive: options.directive } : {}),
          ...(options.archived !== undefined ? { archived: options.archived } : {}),
        },
      ),

    // Resume the most recently updated chat, creating one only when the agent
    // has no existing conversations. This is the safest default for embedded
    // chat surfaces because remounting the UI does not manufacture duplicates.
    getOrCreate: (agentId: number, options?: string | CreateChatOptions) => {
      const active = this.pendingChatResolutions.get(agentId);
      if (active) return active;

      const resolution = (async () => {
        const chats = await this.chat.list(agentId);
        return chats[0] ?? this.chat.create(agentId, options);
      })();
      this.pendingChatResolutions.set(agentId, resolution);
      void resolution.then(
        () => this.pendingChatResolutions.delete(agentId),
        () => this.pendingChatResolutions.delete(agentId),
      );
      return resolution;
    },

    // History — GET /messages. `since` is a message-id cursor (0 = start).
    messages: Object.assign((chatId: string, query: ChatMessagesQuery = {}) => {
      const params = new URLSearchParams({ chat_id: chatId });
      params.set("since", String(query.since ?? 0));
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      return this.get<ChatMessage[]>(
        `/api/apps/channel-chat/messages?${params.toString()}`,
      );
    }, {
      list: (chatId: string, query: ChatMessagesQuery = {}) => {
        const params = new URLSearchParams({ chat_id: chatId });
        params.set("since", String(query.since ?? 0));
        if (query.limit !== undefined) params.set("limit", String(query.limit));
        return this.get<ChatMessage[]>(
          `/api/apps/channel-chat/messages?${params.toString()}`,
        );
      },
      send: (chatId: string, input: ChatSendInput) =>
        this.post<ChatMessage>(
          `/api/apps/channel-chat/messages?chat_id=${encodeURIComponent(chatId)}`,
          {
            content: input.content,
            ...(input.attachments?.length ? { attachments: input.attachments } : {}),
            ...(input.context !== undefined ? { context: input.context } : {}),
            ...(input.clientMessageId ? { client_message_id: input.clientMessageId } : {}),
            ...(input.targetAgentIds?.length ? { target_agent_ids: input.targetAgentIds } : {}),
          },
        ),
    }),

    // Send a user message — POST /messages. The server appends it and
    // forwards it to the agent's /event endpoint, so this one call both
    // records the message and triggers the agent's reply. Returns the
    // persisted user message row.
    send: (
      chatId: string,
      contentOrInput: string | ChatSendInput,
      options: ChatSendOptions = {},
    ) => {
      const input: ChatSendInput = typeof contentOrInput === "string"
        ? { content: contentOrInput, ...options }
        : contentOrInput;
      return this.post<ChatMessage>(
        `/api/apps/channel-chat/messages?chat_id=${encodeURIComponent(chatId)}`,
        {
          content: input.content,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...(input.context !== undefined ? { context: input.context } : {}),
          ...(input.clientMessageId ? { client_message_id: input.clientMessageId } : {}),
          ...(input.targetAgentIds?.length ? { target_agent_ids: input.targetAgentIds } : {}),
        },
      );
    },

    // Live feed for one chat. The chat SSE interleaves two frame
    // shapes on two SSE event names:
    //   - default ("message") events  → full ChatMessage rows
    //   - named "stream" events       → StreamFrame deltas
    // We register listeners for both names — EventSource silently
    // drops named events from the default handler — and discriminate
    // by frame.type so callers see two clean streams:
    //   - full ChatMessage rows  → opts.onMessage
    //   - StreamFrame deltas (type:"stream") → opts.onDelta
    // Returns a StreamHandle — call .close() to stop.
    stream: (chatId: string, opts: ChatStreamOptions): StreamHandle =>
      this.bindAbortSignal(this.subscribe<ChatMessage | StreamFrame>(
        "/api/apps/channel-chat/stream",
        { chat_id: chatId, since: opts.since ?? 0 },
        (frame) => {
          if ((frame as StreamFrame).type === "stream") {
            opts.onDelta?.(frame as StreamFrame);
          } else {
            opts.onMessage?.(frame as ChatMessage);
          }
        },
        {
          EventSource: opts.EventSource,
          onOpen: opts.onOpen,
          onError: opts.onError,
          eventTypes: ["message", "stream"],
        },
      ), opts.signal),

    markSeen: (chatId: string, messageId: number) =>
      this.post<{ last_seen_id: number }>("/api/apps/channel-chat/seen", {
        chat_id: chatId,
        last_seen_id: messageId,
      }),
  };

  // Build a handle for one installed app. The returned object knows
  // both the HTTP route surface (/api/apps/<name>/<route>) and the
  // MCP tool surface (/api/apps/<name>/mcp). T is the default return
  // type for typed route helpers — defaults to unknown so callers
  // either pass a per-call generic or stick to `unknown`.
  app<T = unknown>(name: string, scope: AppScope = {}): AppHandle<T> {
    const explicitProjectId = scope.projectId?.trim();
    const projectId = explicitProjectId || this.projectId;
    const installId = scope.installId;
    if (installId !== undefined && (!Number.isSafeInteger(installId) || installId <= 0)) {
      throw new AptevaError(0, "installId must be a positive safe integer");
    }
    const base = `/api/apps/${encodeURIComponent(name)}`;
    const scopedPath = (path: string) => {
      if (!path.startsWith("/") || path.startsWith("//")) {
        throw new AptevaError(0, "app paths must start with a single slash");
      }
      const url = new URL(base + path, "http://_");
      if (!url.pathname.startsWith(base + "/")) {
        throw new AptevaError(0, "app path must stay within the app");
      }
      // An explicit handle scope wins over per-request query parameters.
      // Preserve legacy query overrides when only the client default is set.
      if (explicitProjectId) url.searchParams.set("project_id", projectId!);
      else if (projectId && !url.searchParams.has("project_id")) url.searchParams.set("project_id", projectId);
      if (installId !== undefined) url.searchParams.set("install_id", String(installId));
      return url.pathname + url.search;
    };
    return {
      name,
      projectId,
      installId,
      get: <R = T>(path: string, init?: RequestInit) => this.get<R>(scopedPath(path), init),
      post: <R = T>(path: string, body?: unknown, init?: RequestInit) =>
        this.post<R>(scopedPath(path), body, init),
      put: <R = T>(path: string, body?: unknown, init?: RequestInit) =>
        this.put<R>(scopedPath(path), body, init),
      patch: <R = T>(path: string, body?: unknown, init?: RequestInit) =>
        this.patch<R>(scopedPath(path), body, init),
      del: <R = T>(path: string, init?: RequestInit) => this.del<R>(scopedPath(path), init),
      tool: async <R = T>(toolName: string, args: Record<string, unknown> = {}, init?: RequestInit) => {
        const env = await this.post<MCPCallResponse<unknown>>(scopedPath("/mcp"), {
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: toolName, arguments: args },
        }, init);
        return unwrapMCP<R>(env);
      },
      subscribe: <E>(path: string, onEvent: (event: E, metadata: SSEEventMetadata) => void, opts?: SubscribeOptions) =>
        this.subscribe<E>(scopedPath(path), undefined, onEvent, opts),
      mcpURL: (queryParams?: Record<string, string>) => {
        const url = new URL(scopedPath("/mcp"), "http://_");
        for (const [key, value] of Object.entries(queryParams ?? {})) url.searchParams.set(key, value);
        return this.baseURL + scopedPath(`/mcp${url.search}`);
      },
    };
  }

  /** Create an extension instance. Retain it in the host; use() does not cache. */
  use<T>(extension: AppExtension<T>, scope?: AppScope): T {
    return extension.create({ app: this.app(extension.app, scope) });
  }

  readonly apps = {
    /** Load an installed app’s bundled client and optional React UI. */
    load: <TClient = unknown, TComponent = unknown>(name: string, options: LoadAppOptions): Promise<LoadedAppFrontend<TClient, TComponent>> =>
      loadAppFrontend<TClient, TComponent>(this.app(name, options), options),
    /** Requires the platform's existing app-list permission. No auth bypass. */
    list: (scope: Pick<AppScope, "projectId"> = {}, init?: RequestInit) => {
      const projectId = scope.projectId ?? this.projectId;
      const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
      return this.get<InstalledApp[]>(`/api/apps${query}`, init);
    },
  };

  // Lower-level direct MCP call. Most callers should use
  // client.app("name").tool("name", args) which routes through this.
  async callTool<R>(
    appName: string,
    toolName: string,
    args: Record<string, unknown>,
    init?: RequestInit,
  ): Promise<R> {
    const path = this.appPath(`/api/apps/${encodeURIComponent(appName)}/mcp`);
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    } as const;
    const env = await this.post<MCPCallResponse<unknown>>(path, body, init);
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

  // Build a fully-qualified URL for a native EventSource endpoint.
  // EventSource cannot send custom headers, so this compatibility path
  // carries API keys in the query string. subscribe() prefers authenticated
  // fetch streaming when an API key is configured.
  sseURL(path: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(this.baseURL + path, "http://_");
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      }
    }
    if (this.apiKey && !this.isAccessTokenCredential() && !url.searchParams.has("api_key")) {
      url.searchParams.set("api_key", this.apiKey);
    }
    return this.baseURL ? this.baseURL + url.pathname + url.search : url.pathname + url.search;
  }

  // Open a live SSE subscription. Generic over the event payload type;
  // each `message` frame's data is JSON-parsed and handed to onEvent.
  // Malformed frames are dropped silently — SSE is best-effort, and one
  // bad frame shouldn't kill the stream.
  //
  // Auth: API-key clients use a fetch-backed SSE reader so the key stays in
  // the canonical Authorization header. Cookie clients use native EventSource
  // with credentials. Returns a StreamHandle — call .close().
  //
  // Node note: needs a global EventSource (Node 22+, browsers, Deno, Bun)
  // or an injected one via opts.EventSource.
  subscribe<E>(
    path: string,
    params: Record<string, string | number | undefined> | undefined,
    onEvent: (event: E, metadata: SSEEventMetadata) => void,
    opts?: SubscribeOptions,
  ): StreamHandle {
    if (opts?.signal?.aborted) return { close() {} };
    if (opts?.reconnectDelayMs !== undefined && (!Number.isFinite(opts.reconnectDelayMs) || opts.reconnectDelayMs < 0)) {
      throw new AptevaError(0, "reconnectDelayMs must be a non-negative finite number");
    }
    if (opts?.deduplicationWindow !== undefined && (!Number.isSafeInteger(opts.deduplicationWindow) || opts.deduplicationWindow < 1)) {
      throw new AptevaError(0, "deduplicationWindow must be a positive safe integer");
    }
    if (opts?.cursorParam && ["project_id", "install_id", "api_key", "access_token"].includes(opts.cursorParam)) {
      throw new AptevaError(0, "cursorParam must not override routing or credentials");
    }
    if (opts?.lastEventId && /[\r\n\0]/.test(opts.lastEventId)) {
      throw new AptevaError(0, "lastEventId must not contain CR, LF or NUL");
    }
    // A supplied EventSource is an explicit transport choice for cookie/sk-
    // clients (and is useful for tests/polyfills). Access tokens always use
    // fetch because they must stay in the Authorization header. Prefix-based
    // detection remains only as a compatibility fallback for legacy callers
    // that passed a delegated token through apiKey.
    const bearerToken = this.bearerToken();
    if (this.appAuth || opts?.transport === "fetch" || opts?.lastEventId !== undefined || opts?.cursorParam ||
        opts?.deduplicate || opts?.reconnectDelayMs !== undefined ||
        (bearerToken && (this.isAccessTokenCredential() || !opts?.EventSource))) {
      return this.bindAbortSignal(this.subscribeWithFetch(path, params, onEvent, opts), opts?.signal);
    }

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
    let closed = false;

    // Default event name "message" handles unnamed (default) frames.
    // Servers that emit named events (`event: foo\n`) need their
    // names listed in opts.eventTypes — EventSource won't deliver
    // those to the default "message" handler. The chat SSE for
    // example sends StreamFrame as `event: stream`.
    const eventTypes = opts?.eventTypes ?? ["message"];
    const handle = (ev: unknown) => {
      if (closed) return;
      const data = (ev as { data?: unknown })?.data;
      if (typeof data !== "string" || data === "") return;
      let parsed: E;
      try {
        parsed = JSON.parse(data) as E;
      } catch {
        return; // drop malformed frame
      }
      const event = ev as { type?: string; lastEventId?: string };
      onEvent(parsed, { event: event.type || "message", id: event.lastEventId || undefined });
    };
    for (const name of eventTypes) {
      es.addEventListener(name as "message", handle);
    }
    if (opts?.onOpen) {
      es.addEventListener("open", () => { if (!closed) opts.onOpen?.(); });
    }
    if (opts?.onError) {
      es.addEventListener("error", (error) => { if (!closed) opts.onError?.(error); });
    }

    return this.bindAbortSignal({ close: () => {
      if (closed) return;
      closed = true;
      es.close();
    } }, opts?.signal);
  }

  private subscribeWithFetch<E>(
    path: string,
    params: Record<string, string | number | undefined> | undefined,
    onEvent: (event: E, metadata: SSEEventMetadata) => void,
    opts?: SubscribeOptions,
  ): StreamHandle {
    let closed = false;
    let controller: AbortController | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let wakeReconnect: (() => void) | undefined;
    let lastEventId = opts?.lastEventId ?? "";
    let renewedSinceOpen = false;
    const delivered = new Set<string>();
    const eventTypes = new Set(opts?.eventTypes ?? ["message"]);
    const close = () => {
      if (closed) return;
      closed = true;
      void reader?.cancel().catch(() => undefined);
      controller?.abort();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      wakeReconnect?.();
    };
    const reportError = (error: unknown) => {
      try { opts?.onError?.(error); } catch { close(); }
    };
    const waitToReconnect = () => new Promise<void>((resolve) => {
      wakeReconnect = resolve;
      reconnectTimer = setTimeout(resolve, opts?.reconnectDelayMs ?? 1_000);
    }).finally(() => {
      reconnectTimer = undefined;
      wakeReconnect = undefined;
    });

    const detachAuth = this.appAuth?.onClear(() => close());
    const run = async () => {
      while (!closed) {
        controller = new AbortController();
        let revision = this.credentialRevision;
        let expiryTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (this.appAuth) {
            await this.appAuth.token();
            if (closed) break;
            revision = this.credentialRevision;
            const deadline = this.appAuth.platformDeadline();
            expiryTimer = setTimeout(() => controller?.abort(), Math.max(1, deadline - Date.now()));
          }
          const url = new URL(this.baseURL + path, "http://_");
          for (const [key, value] of Object.entries(params ?? {})) {
            if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
          }
          if (opts?.cursorParam && lastEventId) url.searchParams.set(opts.cursorParam, lastEventId);
          if (this.appAuth && ["api_key", "access_token"].some(key => url.searchParams.has(key))) throw new AptevaError(403, "Auth mode does not accept URL credentials");
          const headers = new Headers({ Accept: "text/event-stream" });
          const bearerToken = this.bearerToken();
          if (bearerToken) headers.set("Authorization", `Bearer ${bearerToken}`);
          if (lastEventId) headers.set("Last-Event-ID", lastEventId);
          const response = await this.fetchImpl(this.baseURL + url.pathname + url.search, {
            method: "GET", headers,
            credentials: this.isAccessTokenCredential() ? "omit" : "include",
            ...(this.appAuth ? { redirect: "error" as const } : {}),
            signal: controller.signal,
          });
          if (closed) { await response.body?.cancel(); break; }
          if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 401) {
              const renewed = !renewedSinceOpen && await this.renewAfterUnauthorized(revision);
              renewedSinceOpen = renewed;
              if (closed) break;
              if (!this.appAuth || !renewed) this.onUnauthorized?.();
              reportError(new AptevaError(401, "SSE connection failed (401)"));
              if (!renewed) { close(); break; }
              continue;
            }
            if (response.status === 403) {
              reportError(new AptevaError(403, "SSE connection failed (403)"));
              close(); break;
            }
            throw new AptevaError(response.status, `SSE connection failed (${response.status})`);
          }
          if (response.status === 204) { await response.body?.cancel(); close(); break; }
          if (!response.body) throw new AptevaError(0, "SSE response has no body");
          renewedSinceOpen = false;
          reader = response.body.getReader();
          try { opts?.onOpen?.(); } catch (error) { reportError(error); close(); break; }
          const decoder = new TextDecoder();
          let buffer = "";
          let skipLF = false;
          let eventName = "message";
          let frameId: string | undefined;
          let dataLines: string[] = [];
          const dispatch = () => {
            const name = eventName;
            const id = frameId;
            const data = dataLines.join("\n");
            const hasData = dataLines.length > 0;
            dataLines = []; eventName = "message"; frameId = undefined;
            if (id !== undefined) lastEventId = id;
            if (!hasData || !eventTypes.has(name) || closed) return;
            let payload: E;
            try { payload = JSON.parse(data) as E; } catch { return; }
            if (opts?.deduplicate && id && delivered.has(id)) return;
            // IDs identify individual events only when the app promises that.
            if (opts?.deduplicate && id) {
              delivered.add(id);
              if (delivered.size > (opts.deduplicationWindow ?? 1000)) {
                delivered.delete(delivered.values().next().value!);
              }
            }
            try { onEvent(payload, { event: name, id: lastEventId || undefined }); }
            catch (error) { reportError(error); close(); }
          };
          const line = (value: string) => {
            if (!value) { dispatch(); return; }
            if (value.startsWith(":")) return;
            const separator = value.indexOf(":");
            const field = separator < 0 ? value : value.slice(0, separator);
            let content = separator < 0 ? "" : value.slice(separator + 1);
            if (content.startsWith(" ")) content = content.slice(1);
            if (field === "event") eventName = content || "message";
            if (field === "data") dataLines.push(content);
            if (field === "id" && !content.includes("\0")) frameId = content;
          };
          while (!closed) {
            const chunk = await reader.read();
            if (chunk.done || closed) break;
            // Handles LF, CRLF and CR, including CRLF split across chunks.
            for (const char of decoder.decode(chunk.value, { stream: true })) {
              if (closed) break;
              if (skipLF && char === "\n") { skipLF = false; continue; }
              skipLF = false;
              if (char === "\r" || char === "\n") {
                line(buffer); buffer = ""; skipLF = char === "\r";
              } else buffer += char;
            }
          }
          if (!closed) throw new AptevaError(0, "SSE connection closed");
        } catch (error) {
          if (closed) break;
          reportError(error);
          if (this.appAuth && error instanceof AptevaError && (error.status === 401 || error.status === 403)) close();
        } finally {
          if (expiryTimer) clearTimeout(expiryTimer);
          if (reader) {
            try { await reader.cancel(); } catch { /* network already closed */ }
            reader.releaseLock(); reader = undefined;
          }
          controller = undefined;
        }
        if (!closed) await waitToReconnect();
      }
    };
    void run().finally(() => detachAuth?.());
    return { close };
  }

  // --- internals ---

  private bindAbortSignal(handle: StreamHandle, signal?: AbortSignal): StreamHandle {
    if (!signal) return handle;
    const abort = () => {
      signal.removeEventListener("abort", abort);
      handle.close();
    };
    if (signal.aborted) {
      handle.close();
      return handle;
    }
    signal.addEventListener("abort", abort, { once: true });
    return {
      close: () => {
        signal.removeEventListener("abort", abort);
        handle.close();
      },
    };
  }

  private appPath(path: string): string {
    if (!this.projectId) return path;
    const url = new URL(path, "http://_");
    if (!url.searchParams.has("project_id")) {
      url.searchParams.set("project_id", this.projectId);
    }
    return url.pathname + url.search + url.hash;
  }

  private bearerToken(): string | undefined {
    return this.appAuth ? this.accessToken : this.accessToken || this.apiKey;
  }

  private isAccessTokenCredential(): boolean {
    return Boolean(this.appAuth) || Boolean(this.accessToken) || Boolean(this.apiKey?.startsWith("uk_"));
  }

  private async request<R>(
    method: string,
    path: string,
    body: unknown,
    init?: RequestInit,
  ): Promise<R> {
    if (this.appAuth) {
      if (path.startsWith("/api/auth/")) throw new AptevaError(403, "Platform administrator auth is unavailable in app Auth mode");
      if (["api_key", "access_token"].some(key => new URL(path, "http://_").searchParams.has(key))) throw new AptevaError(403, "Auth mode does not accept URL credentials");
      if (new Headers(init?.headers).has("Authorization")) throw new AptevaError(403, "Auth mode does not accept credential overrides");
      await this.appAuth.token();
    }
    const url = this.baseURL + path;
    const revision = this.credentialRevision;
    const headers = new Headers(init?.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const bearerToken = this.bearerToken();
    if (bearerToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${bearerToken}`);
    }

    const ac = this.timeoutMs > 0 ? new AbortController() : undefined;
    const abort = () => ac?.abort(init?.signal?.reason);
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener("abort", abort, { once: true });
    const timer = ac
      ? setTimeout(() => ac.abort(), this.timeoutMs)
      : undefined;

    try {
      const res = await this.fetchImpl(url, {
        method,
        credentials: this.isAccessTokenCredential() ? "omit" : "include",
        ...init,
        ...(this.appAuth ? { credentials: "omit" as const, redirect: "error" as const } : {}),
        headers,
        body: body === undefined ? init?.body : JSON.stringify(body),
        signal: ac?.signal ?? init?.signal,
      });
      if (res.status === 401) {
        const text = await readBody(res);
        // Renew for subsequent calls, but never replay an HTTP operation.
        const renewed = !new Headers(init?.headers).has("Authorization") && await this.renewAfterUnauthorized(revision);
        if (!this.appAuth || !renewed) this.onUnauthorized?.();
        throw new AptevaError(401, text || "unauthorized");
      }
      if (!res.ok) {
        const text = await readBody(res);
        throw new AptevaError(res.status, text || res.statusText);
      }
      if (res.status === 204) return undefined as R;
      const ct = res.headers.get("Content-Type") ?? "";
      if (ct.includes("application/json")) return (await res.json()) as R;
      return (await res.text()) as unknown as R;
    } catch (err) {
      if (err instanceof AptevaError) throw err;
      if (init?.signal?.aborted) throw new AptevaError(0, "request aborted");
      if (ac?.signal.aborted) throw new AptevaError(0, `request timeout after ${this.timeoutMs}ms`);
      throw new AptevaError(0, err instanceof Error ? err.message : String(err));
    } finally {
      if (timer) clearTimeout(timer);
      init?.signal?.removeEventListener("abort", abort);
    }
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
  readonly projectId?: string;
  readonly installId?: number;
  get<R = TDefault>(path: string, init?: RequestInit): Promise<R>;
  post<R = TDefault>(path: string, body?: unknown, init?: RequestInit): Promise<R>;
  put<R = TDefault>(path: string, body?: unknown, init?: RequestInit): Promise<R>;
  patch<R = TDefault>(path: string, body?: unknown, init?: RequestInit): Promise<R>;
  del<R = TDefault>(path: string, init?: RequestInit): Promise<R>;
  tool<R = TDefault>(name: string, args?: Record<string, unknown>, init?: RequestInit): Promise<R>;
  subscribe<E>(path: string, onEvent: (event: E, metadata: SSEEventMetadata) => void, opts?: SubscribeOptions): StreamHandle;
  mcpURL(queryParams?: Record<string, string>): string;
}
