import { AptevaError } from "./errors.js";
import type {
  AptevaClientOptions,
  AuthStatus,
  MCPCallResponse,
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
