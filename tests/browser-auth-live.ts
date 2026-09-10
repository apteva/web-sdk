// Invoked by Auth's TestWebSDKPersistentBrowserIntegration; no live accounts.
import { chromium, expect, type Page } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const temp = await mkdtemp(join(tmpdir(), "sdk-real-auth-"));
const source = join(temp, "entry.ts");
await writeFile(source, `import { AptevaClient } from ${JSON.stringify(process.env.SDK_TEST_MODULE || resolve(import.meta.dir,"../src/index.ts"))};
window.client = new AptevaClient({baseURL:location.origin,projectId:"test-proj",auth:{clientId:${JSON.stringify(process.env.AUTH_INTEGRATION_CLIENT)},persistence:"local"}});`);
const build = await Bun.build({ entrypoints: [source], target: "browser" });
if (!build.success) throw Error(String(build.logs));
const code = await build.outputs[0].text();
const upstream = process.env.AUTH_INTEGRATION_URL!;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/") return new Response('<script type="module" src="/sdk.js"></script>', { headers: { "Content-Type": "text/html" } });
  if (url.pathname === "/sdk.js") return new Response(code, { headers: { "Content-Type": "text/javascript" } });
  return fetch(new Request(upstream + url.pathname + url.search, request), { redirect: "error" });
} });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
async function tab() { const p = await context.newPage(); await p.goto(server.url.origin); await p.waitForFunction(() => Boolean((window as any).client)); return p; }
const restore = (p: Page) => p.evaluate(() => (window as any).client.auth.restore());
try {
  const a = await tab();
  const user = await a.evaluate(() => (window as any).client.auth.login({ email: "browser@example.com", password: "GoodPassword123" }));
  await a.reload(); await a.waitForFunction(() => Boolean((window as any).client));
  expect((await restore(a)).user.id).toBe(user.id);
  const b = await tab(), c = await tab(); await Promise.all([restore(b), restore(c)]);
  await Promise.all([a,b,c].map(p => p.evaluate(() => (window as any).client.auth.me())));
  // A real SQLite rollback leaves the saved refresh credential usable.
  const outage = await fetch(upstream + "/fixture/refresh-outage", { method: "POST" }); expect(outage.status).toBe(204);
  const d = await tab(); await expect(restore(d)).rejects.toThrow();
  expect(await d.evaluate(() => (window as any).client.auth.getState().error.code)).toBe("http_503");
  const recovery = await fetch(upstream + "/fixture/refresh-outage", { method: "DELETE" }); expect(recovery.status).toBe(204);
  expect((await restore(d)).user.id).toBe(user.id);
  await a.evaluate(() => (window as any).client.auth.logout());
  await Promise.all([b,c,d].map(p => p.waitForFunction(() => !(window as any).client.auth.getSession())));
  const e = await tab(); expect(await restore(e)).toBeUndefined();
  console.log("Real Auth + Chromium persistence passed: reload, simultaneous tabs, single-use rotation, transient database rollback, explicit retry and cross-tab logout.");
} finally { await browser.close(); server.stop(true); await rm(temp, { recursive: true, force: true }); }
