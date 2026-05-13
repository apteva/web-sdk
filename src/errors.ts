// Thrown for every non-2xx HTTP response and every MCP-level error
// from /api/apps/<name>/mcp. status is the HTTP status (or 0 for
// network/transport failures, or -1 for JSON-RPC errors that came
// back inside a 200 envelope). body is the raw response body (text)
// or the JSON-RPC error.message — whichever was available.
export class AptevaError extends Error {
  status: number;
  body: string;
  code?: number;

  constructor(status: number, body: string, code?: number) {
    super(`HTTP ${status}: ${body}`);
    this.name = "AptevaError";
    this.status = status;
    this.body = body;
    this.code = code;
  }

  isUnauthorized(): boolean {
    return this.status === 401;
  }

  isNotFound(): boolean {
    return this.status === 404;
  }
}
