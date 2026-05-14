export interface User {
  user_id?: number;
  id?: number;
  email?: string;
  name?: string;
  role?: string;
  onboarding_complete?: boolean;
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
// `apiKey` attaches Authorization: Bearer on every request. Both
// can coexist — Bearer wins on the wire when set.
export type AuthCarrier = "cookie" | "apiKey";

export interface AptevaClientOptions {
  // Base URL of the apteva-server. "/api" is appended by the client
  // automatically; pass "https://agents.example.com", not
  // "https://agents.example.com/api".
  baseURL: string;
  // Optional API key. When set, sent as `Authorization: Bearer <key>`
  // on every request. Leave undefined to rely on session cookies.
  apiKey?: string;
  // Custom fetch implementation (test injection, edge runtimes).
  fetch?: typeof fetch;
  // Called once whenever a request returns 401. The client throws an
  // AptevaError(401) regardless — this is just a notification hook
  // for re-rendering "please log in" UIs.
  onUnauthorized?: () => void;
  // Default request timeout in ms. 0 = no timeout. Defaults to 30_000.
  timeoutMs?: number;
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
  addEventListener(type: "message" | "error", listener: (ev: unknown) => void): void;
  close(): void;
}
export type EventSourceCtor = new (
  url: string,
  init?: { withCredentials?: boolean },
) => EventSourceLike;

export interface SubscribeOptions {
  // Inject an EventSource implementation. Defaults to globalThis.EventSource
  // (browsers, Node 22+, Deno, Bun). Pass a polyfill or a stub otherwise.
  EventSource?: EventSourceCtor;
  // Called on the EventSource "error" event. SSE auto-reconnects, so this
  // is informational — the stream stays open unless you close() it.
  onError?: (err: unknown) => void;
}
