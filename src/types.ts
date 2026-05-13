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
