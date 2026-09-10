import type { AppComponentReference } from "./components.js";

export interface User {
  user_id?: number;
  id?: number;
  email?: string;
  name?: string;
  role?: string;
  onboarding_complete?: boolean;
}

export interface Project {
  id: string;
  user_id: number;
  name: string;
  description?: string;
  color?: string;
  created_at: string;
}

export interface AuthStatus {
  authenticated: boolean;
  user?: User;
  needs_setup?: boolean;
}

export interface AuthBranding {
  title_template?: string;
  logo?: string;
  theme_css?: string;
}

// Shape apteva-server injects into served index.html when a UI is
// hosted as a static app on the platform itself. Mirrors the payload
// built in server/apps_static.go::newStaticAppFileHandler.
export interface AptevaAppInjection {
  base?: string;
  api_base?: string;
  app_name?: string;
  install_id?: number;
  default_project?: string;
  kiosk_api_key?: string;
  branding?: AuthBranding;
  installed_apps?: string[];
}

declare global {
  interface Window {
    __APTEVA_APP__?: AptevaAppInjection;
    __API_BASE__?: string;
    __DEFAULT_PROJECT__?: string;
  }
}

// Carrier the client uses to authenticate against /api/*. `cookie`
// relies on the session cookie (same-origin or CORS-credentialed);
// `apiKey` and `accessToken` attach Authorization: Bearer. An explicit
// access token takes precedence over an API key.
export type AuthCarrier = "cookie" | "apiKey" | "accessToken";

export interface AptevaClientOptions {
  /** Unified Auth app sessions; cannot be combined with other credentials. */
  auth?: import("./auth-session.js").AppAuthOptions;
  // Base URL of the apteva-server. "/api" is appended by the client
  // automatically; pass "https://agents.example.com", not
  // "https://agents.example.com/api".
  baseURL: string;
  // Optional API key. When set, sent as `Authorization: Bearer <key>`
  // on every request. Leave undefined to rely on session cookies.
  apiKey?: string;
  // Optional opaque bearer token issued for the current application user.
  // The SDK does not depend on the service that minted it or inspect its
  // prefix. Access-token requests omit cookies, keep the token out of URLs,
  // and use authenticated fetch for SSE. Takes precedence over apiKey.
  accessToken?: string;
  // Default project context for installed-app HTTP and MCP routes. The SDK
  // appends it as ?project_id= so the server can select the project-scoped
  // app installation before forwarding the request.
  projectId?: string;
  // Host-owned renewal hook, coordinated across concurrent 401s. A successful
  // refresh affects future HTTP calls; the failed call still throws (no replay).
  // Fetch SSE may reconnect with the renewed token. Undefined leaves auth intact.
  refreshAccessToken?: () => Promise<string | undefined>;
  // Custom fetch implementation (test injection, edge runtimes).
  fetch?: typeof fetch;
  // Called once whenever a request returns 401. The client throws an
  // AptevaError(401) regardless — this is just a notification hook
  // for re-rendering "please log in" UIs.
  onUnauthorized?: () => void;
  // Default request timeout in ms. 0 = no timeout. Defaults to 30_000.
  timeoutMs?: number;
}

// --- Delegated browser users ---------------------------------------------

/**
 * Input used by a trusted backend to mint a short-lived Channel Chat token.
 * This call requires a private `sk-...` API key and must never run in a
 * production browser.
 *
 * @deprecated Prefer a generic access token issued by Auth (or another
 * trusted identity service) and pass it to AptevaClient as `accessToken`.
 */
export interface CreateDelegatedUserInput {
  projectId: string;
  subjectId: string;
  subjectType?: string;
  agentId?: number;
  allowedAgentIds?: number[];
  allowedOrigins: string[];
  conversationDirective?: string;
  expiresIn?: number;
  rateLimitPerMinute?: number;
}

export interface DelegatedUserToken {
  access_token: string;
  token_type: "Bearer" | (string & {});
  expires_in: number;
  expires_at: string;
  key_prefix: string;
  project_id: string;
  allowed_agent_ids: number[];
  subject: { type: string; id: string };
}

// MCP JSON-RPC envelope shapes — exposed so callers building bespoke
// MCP requests can type their bodies without redeclaring them.
export interface MCPCallRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: "tools/call";
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface MCPCallResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result?: {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string; data?: T };
}

// --- Agents ---------------------------------------------------------------
//
// An "agent" is a running apteva-core child process — the entity the
// platform's vocabulary converged on (formerly "instance"). The server
// serves these at /api/agents (with /api/instances kept as an alias).

export interface Agent {
  id: number;
  user_id: number;
  name: string;
  directive: string;
  mode: string;
  config: string;
  port: number;
  pid: number;
  status: "running" | "stopped";
  project_id?: string;
  created_at: string;
}

export type AgentMode = "autonomous" | "cautious" | "learn";

export interface AgentGrantRule {
  resource?: string;
  action?: string;
  effect?: "allow" | "deny" | (string & {});
  conditions?: Record<string, unknown>;
}

export interface AgentBoundAppGrant {
  install_id: number;
  default_effect?: "allow" | "deny" | (string & {});
  rules: AgentGrantRule[];
}

// POST /api/agents request body. `config` is the server-side JSON blob
// string used for MCP servers and other boot-time settings.
export interface AgentCreateInput {
  name: string;
  directive?: string;
  mode?: AgentMode;
  config?: string;
  project_id?: string;
  start?: boolean;
  include_channels?: boolean;
  unconscious?: boolean;
  template_id?: string;
  bound_app_install_ids?: number[];
  bound_app_grants?: AgentBoundAppGrant[];
  bound_connection_ids?: number[];
}

// If the row is created but cannot start (for example no LLM provider is
// configured), the server returns a compact warning shape instead of the full
// Agent row. Successful creates return Agent.
export interface AgentCreateWarning {
  id: number;
  name: string;
  status: "stopped" | (string & {});
  warning: string;
}

export type AgentCreateResult = Agent | AgentCreateWarning;

export interface AgentUpdateInput {
  name: string;
}

export interface AgentDeleteResult {
  status: "deleted" | (string & {});
}

export interface AgentConfig {
  directive?: string;
  mode?: AgentMode | (string & {});
  mcp_servers?: Array<Record<string, unknown>>;
  providers?: Array<Record<string, unknown>>;
  threads?: Array<Record<string, unknown>>;
  unconscious?: boolean;
  reset?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgentSystemMCPResult {
  name: string;
  enable: boolean;
  previous: boolean;
  restart_required: boolean;
}

export interface AgentCoreEvent {
  id?: string;
  type?: string;
  thread_id?: string;
  data?: unknown;
  [key: string]: unknown;
}

// POST /api/agents/:id/restart response.
export interface AgentRestartResult {
  status: string;
}

// POST /api/agents/:id/pause response. The endpoint is a toggle —
// `paused` is the resulting state after the flip.
export interface AgentPauseResult {
  paused: boolean;
}

// Live runtime snapshot for one agent — GET /api/agents/:id/status.
export interface AgentStatus {
  iteration: number;
  rate: string;
  model: string;
  paused: boolean;
  threads: number;
  memories: number;
  uptime_seconds: number;
  mode: string;
}

export interface Thread {
  id: string;
  parent_id?: string;
  depth: number;
  directive: string;
  tools?: string[];
  mcp_names?: string[];
  iteration: number;
  rate: string;
  model: string;
  age: string;
}

export interface ChannelInfo {
  name: string;
  type: string;
  connected: boolean;
}

export interface ChatHistoryMessage {
  id: string;
  role: "user" | "agent" | "tool" | "status";
  text: string;
  time: string;
  tool_name?: string;
  tool_done?: boolean;
  tool_duration_ms?: number;
  tool_success?: boolean;
}

// --- Activity / telemetry -------------------------------------------------

export type TelemetryType =
  | "llm.start"
  | "llm.done"
  | "llm.error"
  | "tool.call"
  | "tool.result"
  | "tool.pending"
  | "tool.approved"
  | "tool.rejected"
  | "thread.spawn"
  | "thread.done"
  | "event.received"
  | "mode.changed"
  // The server may add types over time; keep the union open.
  | (string & {});

export interface TelemetryEvent {
  id: string;
  instance_id: number;
  thread_id: string;
  type: TelemetryType;
  time: string; // RFC3339
  data: Record<string, unknown>;
}

// Filters for telemetry.query → GET /api/telemetry.
export interface TelemetryQuery {
  agentId: number;
  type?: TelemetryType;
  threadId?: string;
  since?: string; // RFC3339
  limit?: number;
}

// Aggregate counters over a window — GET /api/telemetry/stats.
export interface TelemetryStats {
  total_events: number;
  llm_calls: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost: number;
  avg_duration_ms: number;
  threads_spawned: number;
  threads_done: number;
  tool_calls: number;
  errors: number;
}

// One time-bucketed row — GET /api/telemetry/timeline.
export interface TimelineBucket {
  time: string;
  llm_calls: number;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  tool_calls: number;
  errors: number;
  threads: Record<string, number>; // thread_id → call count
}

export type TelemetryPeriod = "1h" | "24h" | "7d";

// --- Chat -----------------------------------------------------------------
//
// Chat is served by the built-in `channel-chat` app. The SDK reaches it
// through the standard app proxy at /api/apps/channel-chat/*. One chat
// belongs to one agent; messages flow both ways and the agent's response
// streams token-by-token as StreamFrames on the same SSE feed.

export interface Chat {
  id: string;
  /** Lead agent for this conversation. New code should use this field. */
  agent_id: number;
  /** Legacy alias for agent_id. */
  instance_id?: number;
  /** Complete participant set; direct chats contain agent_id only. */
  agent_ids: number[];
  project_id: string;
  kind: "direct" | "room" | (string & {});
  title: string;
  /** Durable instructions scoped to this conversation only. */
  directive: string;
  /** External delegated-user identity. Omitted for ordinary owner chats. */
  subject_type?: string;
  subject_id?: string;
  /** Stable key used to atomically resume a delegated user's conversation. */
  conversation_key?: string;
  /** Present on create/createOrResume responses. */
  created?: boolean;
  created_at: string;
  updated_at: string;
  archived_at?: string;
  thread_id?: string;
}

export interface CreateChatOptions {
  title?: string;
  /** Durable conversation-only instructions. Maximum 8,000 characters server-side. */
  directive?: string;
  /** Delegated-user resume key. Prefer chat.createOrResume() when using it. */
  conversationKey?: string;
}

/** Options for an atomic delegated-user conversation create/resume. */
export interface CreateOrResumeChatOptions {
  title?: string;
  conversationKey: string;
}

export type ChatCreateResult = Chat & { created: boolean };

export interface UpdateChatOptions {
  title?: string;
  /** Set to an empty string to clear the conversation directive. */
  directive?: string;
  archived?: boolean;
}

/** Backward-compatible name for a generic app component reference. */
export interface ChatComponent extends AppComponentReference {}

/** A user-supplied image attached to a chat message. */
export interface ChatAttachment {
  id?: string;
  type: "image";
  /** Base64 data URL accepted by channel-chat. */
  data_url?: string;
  name?: string;
  mime_type?: string;
  size?: number;
  ephemeral?: boolean;
}

export interface ChatSendOptions {
  attachments?: ChatAttachment[];
  /** Optional server-side message context for advanced chat surfaces. */
  context?: unknown;
  /** Idempotency key used when a caller may retry the same send. */
  clientMessageId?: string;
  /** Optional room-agent routing. Direct chats normally omit this. */
  targetAgentIds?: number[];
}

/** Object-form chat send input. Prefer a stable clientMessageId for retries. */
export interface ChatSendInput extends ChatSendOptions {
  content: string;
}

export interface ChatMessage {
  id: number;
  chat_id: string;
  role: "user" | "agent" | "system";
  content: string;
  user_id?: number;
  thread_id?: string;
  // "streaming" while the agent is still producing it, "final" once done.
  status: "streaming" | "final";
  created_at: string;
  // Lifecycle metadata from channel-chat. `phase` is commonly
  // acknowledgement | progress | final for agent messages.
  metadata?: Record<string, unknown>;
  // Rich attachments — always present (may be empty).
  components: ChatComponent[];
  // User-supplied images — always present in current server responses.
  attachments: ChatAttachment[];
}

// Ephemeral token-delta frame on the chat SSE stream. Distinguished
// from a full ChatMessage by `type: "stream"` — ChatMessage has no
// `type` field. Replace a call's bubble with cumulative `text` until `done`.
export interface StreamFrame {
  type: "stream";
  chat_id: string;
  thread_id: string;
  call_id: string;
  // Current best-effort response text. This is cumulative: replace the
  // provisional bubble for this call_id on every frame; do not append it.
  text: string;
  phase?: "acknowledgement" | "progress" | "final";
  done: boolean;
  created_at: string;
}

export interface ChatMessagesQuery {
  since?: number; // message id cursor — 0 = from the start
  limit?: number; // default 500 server-side
}

// Options for chat.stream(). onMessage gets full ChatMessage rows;
// onDelta gets the token-by-token StreamFrames. Either may be omitted.
export interface ChatStreamOptions {
  onMessage?: (message: ChatMessage) => void;
  onDelta?: (frame: StreamFrame) => void;
  since?: number;
  // Same injectable EventSource escape hatch as subscribe().
  EventSource?: EventSourceCtor;
  onOpen?: () => void;
  onError?: (err: unknown) => void;
  /** Abort the stream and suppress reconnects. */
  signal?: AbortSignal;
}

// --- SSE / streaming ------------------------------------------------------

// Handle returned by subscribe() / telemetry.stream(). Call close() to
// tear down the underlying EventSource.
export interface StreamHandle {
  close: () => void;
}

// Minimal structural type for an EventSource constructor — lets callers
// inject a polyfill (Node < 22, test doubles) without the SDK taking a
// hard dependency on the DOM lib's EventSource.
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  close(): void;
}
export type EventSourceCtor = new (
  url: string,
  init?: { withCredentials?: boolean },
) => EventSourceLike;

export interface SSEEventMetadata {
  event: string;
  /** SSE id, if supplied by the backend. Not a message-row identifier. */
  id?: string;
}

export interface SubscribeOptions {
  /** Close the subscription and suppress reconnects. */
  signal?: AbortSignal;
  /** Force fetch streaming, including for cookie authentication. */
  transport?: "fetch";
  /** Fetch reconnect delay; defaults to 1000ms. Enables fetch transport. */
  reconnectDelayMs?: number;
  /** Resume via Last-Event-ID. Requires backend support; enables fetch. */
  lastEventId?: string;
  /** Also send the resume ID in this query parameter, if the app requires it. */
  cursorParam?: string;
  /** Opt-in bounded deduplication of explicit SSE IDs. Requires unique event IDs. */
  deduplicate?: boolean;
  /** Number of delivered IDs to retain; defaults to 1000. */
  deduplicationWindow?: number;
  // Inject an EventSource implementation. Defaults to globalThis.EventSource
  // (browsers, Node 22+, Deno, Bun). Pass a polyfill or a stub otherwise.
  EventSource?: EventSourceCtor;
  // Called whenever the stream opens, including after EventSource reconnects.
  onOpen?: () => void;
  // Called on the EventSource "error" event. SSE auto-reconnects, so this
  // is informational — the stream stays open unless you close() it.
  onError?: (err: unknown) => void;
  // SSE event names to listen for. Defaults to ["message"] — the
  // unnamed default-event channel. Servers that emit `event: <name>\n`
  // lines (named events) need their names here, or those frames are
  // silently dropped. EventSource only delivers to listeners
  // registered for matching event names. Each delivered payload is
  // JSON-parsed and handed to onEvent — discriminate by an in-payload
  // field if multiple event types share one handler.
  eventTypes?: string[];
}
