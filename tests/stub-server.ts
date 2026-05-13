// Tiny stand-in for apteva-server's relevant routes. Each test starts
// its own instance on an ephemeral port so suites don't share state.
// The stub captures the last request's headers/body so assertions can
// verify carrier injection, MCP envelopes, etc.

import { serve } from "bun";

export type Captured = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  cookieHeader?: string;
  url: string;
};

export interface StubServer {
  url: string;
  port: number;
  stop(): Promise<void>;
  // Last request the stub saw — undefined before any call lands.
  last(): Captured | undefined;
  // All requests in order.
  all(): Captured[];
  // Override a route's response for the next call.
  setRoute(method: string, path: string, handler: RouteHandler): void;
}

type RouteHandler = (req: Request, capture: Captured) => Response | Promise<Response>;

interface RouteKey {
  method: string;
  path: string;
}

function keyOf(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function startStubServer(initial?: Record<string, RouteHandler>): StubServer {
  const captures: Captured[] = [];
  const routes = new Map<string, RouteHandler>();

  // Defaults — overridable per-test via setRoute.
  routes.set(
    keyOf("POST", "/api/auth/login"),
    () => json({ user_id: 7, email: "u@example.com", name: "U" }, 200),
  );
  routes.set(
    keyOf("POST", "/api/auth/logout"),
    () => new Response(null, { status: 204 }),
  );
  routes.set(
    keyOf("GET", "/api/auth/me"),
    () => json({ user_id: 7, email: "u@example.com" }, 200),
  );

  const server = serve({
    port: 0,
    fetch: async (req): Promise<Response> => {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      const cap: Captured = {
        method: req.method,
        path: url.pathname,
        headers,
        body,
        cookieHeader: headers["cookie"],
        url: req.url,
      };
      captures.push(cap);

      const handler =
        routes.get(keyOf(req.method, url.pathname)) ??
        routes.get(keyOf(req.method, url.pathname + "/")) ??
        routes.get(keyOf("*", url.pathname));
      if (handler) return handler(req, cap);
      return new Response("not found", { status: 404 });
    },
  });

  if (initial) {
    for (const [k, h] of Object.entries(initial)) {
      const [method, ...rest] = k.split(" ");
      routes.set(keyOf(method!, rest.join(" ")), h);
    }
  }

  const port = server.port!;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stop: () => server.stop(true) as unknown as Promise<void>,
    last: () => captures[captures.length - 1],
    all: () => captures.slice(),
    setRoute: (method, path, h) => routes.set(keyOf(method, path), h),
  };
}

export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
