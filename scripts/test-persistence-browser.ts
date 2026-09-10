// Real browser documents exercise native Web Locks, localStorage and notifications.
import { chromium, expect, type Page } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const temp = await mkdtemp(join(tmpdir(), "apteva-browser-sessions-"));
const source = join(temp, "browser.ts");
await writeFile(source, `import { AptevaClient } from ${JSON.stringify(resolve(import.meta.dir, "../src/index.ts"))};
window.start = (persistence = "local") => { window.client?.auth.dispose(); window.client = new AptevaClient({ baseURL: location.origin, projectId: "project", auth: { clientId: "public", persistence } }); };
window.start();`);
const bundle = await Bun.build({ entrypoints: [source], target: "browser" });
if (!bundle.success) throw new Error(String(bundle.logs));
const js = await bundle.outputs[0].text();
let revision = 0, family = 0, refreshes = 0, reuse = 0, writes = 0, closedStreams = 0;
let mode = "ok", barrier: Promise<void> | undefined;
const credentials = new Map<string, { family: number; user: number; used: boolean }>();
const access = new Map<string, { family: number; user: number; kind: "auth" | "platform" }>();
const revoked = new Set<number>();
function issue(family: number, user: number) {
  const id = ++revision, refresh = `refresh-${id}`;
  credentials.set(refresh, { family, user, used: false });
  access.set(`auth-${id}`, { family, user, kind: "auth" }); access.set(`platform-${id}`, { family, user, kind: "platform" });
  return { user: { id: user }, authorization: { roles: ["user"], permissions: [], authorization_version: id },
    access_token: `auth-${id}`, refresh_token: refresh, expires_in: 900, apteva_access_token: `platform-${id}`,
    apteva_expires_in: 60, apteva_expires_at: new Date(Date.now() + 60000).toISOString() };
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response('<script type="module" src="/sdk.js"></script>', { headers: { "Content-Type": "text/html" } });
  if (path === "/sdk.js") return new Response(js, { headers: { "Content-Type": "text/javascript" } });
  if (path.startsWith("/api/apps/auth/")) {
    const body = await request.json() as any;
    if (path.endsWith("/login")) return Response.json(issue(++family, body.email === "bob" ? 2 : 1));
    if (path.endsWith("/logout")) { const r = credentials.get(body.refresh_token); if (r) revoked.add(r.family); return new Response(null, { status: 204 }); }
    if (path.endsWith("/refresh")) {
      refreshes++; if (barrier) await barrier;
      if (mode === "safe503") return Response.json({ error: "refresh_unavailable" }, { status: 503 });
      const r = credentials.get(body.refresh_token);
      if (!r || revoked.has(r.family)) return Response.json({ error: "invalid_grant" }, { status: 401 });
      if (r.used) { reuse++; revoked.add(r.family); return Response.json({ error: "invalid_grant" }, { status: 401 }); }
      r.used = true; const result = issue(r.family, r.user);
      if (mode === "lost") return new Response("proxy lost response", { status: 502 });
      return Response.json(result);
    }
  }
  const token = request.headers.get("Authorization")?.replace("Bearer ", "") || "";
  const credential = access.get(token), kind = path.startsWith("/api/apps/conversations/") ? "platform" : "auth";
  if (request.method === "POST") writes++;
  if (!credential || credential.kind !== kind || revoked.has(credential.family) || mode === "reject") return new Response("denied", { status: 401 });
  if (path.endsWith("/events")) {
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"ready":true}\n\n'));
      request.signal.addEventListener("abort", () => { closedStreams++; try { controller.close(); } catch {} });
    }, cancel() { closedStreams++; } });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  }
  return Response.json({ user: credential.user });
} });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const pages: Page[] = [];
async function tab() { const p = await context.newPage(); pages.push(p); await p.goto(server.url.origin); await p.waitForFunction(() => Boolean((window as any).client)); return p; }
const login = (p: Page, email = "alice") => p.evaluate(email => (window as any).client.auth.login({ email, password: "test" }), email);
const restore = (p: Page) => p.evaluate(() => (window as any).client.auth.restore());
const state = (p: Page) => p.evaluate(() => (window as any).client.auth.getState());
try {
  const a = await tab(); await login(a);
  const saved = await a.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith("apteva.auth.v1:"))!)!));
  expect(Object.keys(saved).sort()).toEqual(["generation", "refreshToken", "revision", "scope", "state", "version"]);
  await a.reload(); await a.waitForFunction(() => Boolean((window as any).client)); expect((await state(a)).status).toBe("idle");
  await restore(a);
  const b = await tab(), c = await tab(); await Promise.all([restore(b), restore(c)]); expect(reuse).toBe(0);
  await Promise.all([a, b, c].map(p => p.evaluate(() => Promise.all([
    (window as any).client.app("api", { credential: "auth" }).get("/crm"),
    (window as any).client.app("conversations").get("/chats"),
  ])))); expect(reuse).toBe(0);
  // Both stream kinds are tied to the same restored session.
  await b.evaluate(() => {
    const w = window as any; w.events = 0;
    w.client.app("api", { credential: "auth" }).subscribe("/events", () => { w.events++; });
    w.client.app("conversations").subscribe("/events", () => { w.events++; });
  });
  await b.waitForFunction(() => (window as any).events === 2);
  await a.evaluate(() => (window as any).client.auth.logout());
  await Promise.all([b, c].map(p => p.waitForFunction(() => !(window as any).client.auth.getSession())));
  await expect.poll(() => closedStreams).toBeGreaterThanOrEqual(2);
  await a.close(); const reopened = await tab(); expect(await restore(reopened)).toBeUndefined();
  // Safe outages permit an explicit retry without replaying a consumed token.
  await login(reopened); mode = "safe503";
  await expect(restore(b)).rejects.toThrow(); expect((await state(b)).status).toBe("error");
  mode = "ok"; await restore(b);
  // Account switch while restore is waiting on a rotating response.
  let release!: () => void; barrier = new Promise(resolve => { release = resolve; });
  const before = refreshes; const restoring = restore(c).catch(() => undefined);
  await expect.poll(() => refreshes).toBeGreaterThan(before);
  const switching = login(c, "bob"); release(); await Promise.all([restoring, switching]); barrier = undefined;
  expect(await c.evaluate(() => (window as any).client.auth.getSession().user.id)).toBe(2);
  // A write rejected after restoration is never automatically replayed.
  mode = "reject"; const priorWrites = writes;
  await expect(c.evaluate(() => (window as any).client.app("api", { credential: "auth" }).post("/crm", {}))).rejects.toThrow();
  expect(writes - priorWrites).toBe(1); mode = "ok";
  // Lose the response after rotation; a new tab must not reuse the saved token.
  const d = await tab(); mode = "lost"; await expect(restore(d)).rejects.toThrow(); const beforeRetry = refreshes;
  mode = "ok"; const e = await tab(); await expect(restore(e)).rejects.toThrow(); expect(refreshes).toBe(beforeRetry); expect(reuse).toBe(0);
  // No Web Locks: report the fallback and keep fresh login in memory only.
  const isolated = await browser.newContext(); await isolated.addInitScript(() => Object.defineProperty(navigator, "locks", { value: undefined }));
  const unsupported = await isolated.newPage(); await unsupported.goto(server.url.origin); await unsupported.waitForFunction(() => Boolean((window as any).client));
  expect((await state(unsupported)).persistence).toBe("unavailable"); await login(unsupported);
  expect(await unsupported.evaluate(() => localStorage.length)).toBe(0); await isolated.close();
  console.log("Browser persistence passed: reload, real cross-tab locks, mixed handles, streams, logout, account switching, outages, no replay and unavailable locks.");
} finally { await browser.close(); server.stop(true); await rm(temp, { recursive: true, force: true }); }
