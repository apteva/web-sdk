import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AptevaClient as Client } from "../../src";

export async function withMixedApps(AptevaClient: typeof Client, authHost: string, run: (client: Client, host: string) => Promise<void>) {
  const temp = await mkdtemp(join(tmpdir(), "sdk-app-fixtures-"));
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  let gateway: ReturnType<typeof Bun.serve> | undefined;
  try {
    // Bootstrap fixture identity with a separate session, then close it.
    const bootstrap = new AptevaClient({ baseURL: authHost, projectId: "test-proj", auth: { clientId: process.env.AUTH_INTEGRATION_CLIENT!, profile: "commercial" } });
    const user = await bootstrap.auth.login({ email: "sdk@example.com", password: "GoodPassword123" }) as any;
    await bootstrap.auth.logout();
    const targets: Record<string, string> = {};
    for (const app of ["api", "telephony"]) {
      const ready = join(temp, app);
      const p = Bun.spawn([process.env[`SDK_MIXED_${app.toUpperCase()}`]!, "-test.run=^TestSDKMixedFixture$", "-test.timeout=100s"], {
        cwd: join(process.env.SDK_MIXED_APPS!, "mcp", app), stdout: "inherit", stderr: "inherit",
        env: { ...process.env, APTEVA_GATEWAY_URL: authHost, SDK_FIXTURE_READY: ready, SDK_FIXTURE_USER: String(user.id), SDK_FIXTURE_ORG: String(user.organization_id) },
      });
      processes.push(p);
      for (let i = 0; i < 200; i++) {
        try { targets[app] = await readFile(ready, "utf8"); break; } catch { await Bun.sleep(25); }
      }
      if (!targets[app]) throw Error(`${app} fixture did not start`);
    }
    let refreshToken: string | undefined;
    gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, error: () => new Response("Fixture proxy failure", {status:502}), async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture/revoke-session") {
        return fetch(authHost + "/api/apps/auth/logout?project_id=test-proj", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: process.env.AUTH_INTEGRATION_CLIENT, refresh_token: refreshToken }) });
      }
      const match = url.pathname.match(/^\/api\/apps\/(api|telephony)(\/.*)$/);
      const destination = match ? targets[match[1]] + match[2] + url.search : authHost + url.pathname + url.search;
      const response = await fetch(new Request(destination, request), { redirect: "error" });
      if (["/api/apps/auth/login", "/api/apps/auth/refresh"].includes(url.pathname) && response.ok) {
        refreshToken = (await response.clone().json() as any).refresh_token;
      }
      return response;
    } });
    const host = gateway.url.origin;
    const client = new AptevaClient({ baseURL: host, projectId: "test-proj", auth: { clientId: process.env.AUTH_INTEGRATION_CLIENT!, profile: "commercial" } });
    await run(client, host);
  } finally {
    gateway?.stop(true);
    for (const p of processes) p.kill();
    await Promise.all(processes.map(p => p.exited));
    await rm(temp, { recursive: true, force: true });
  }
}
