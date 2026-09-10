// Run by Auth's TestWebSDKSessionIntegration using a real Auth HTTP handler.
import { withMixedApps } from "./integration/mixed-live";
// The release check can import the unpacked npm artifact instead of source.
const { AptevaClient } = await import(process.env.SDK_TEST_MODULE || "../src/index.ts");
const host = process.env.AUTH_INTEGRATION_URL!;
const client = new AptevaClient({ baseURL: host, projectId: "test-proj", auth: {
  clientId: process.env.AUTH_INTEGRATION_CLIENT!, profile: "commercial",
} });
async function check(client: import("../src").AptevaClient, host: string) {
  const user = await client.auth.login({ email: "sdk@example.com", password: "GoodPassword123" });
  if (!user.id || !client.auth.getSession()?.platformExpiresAt) throw Error("Missing login/session");
  await client.app("conversations").get("/chats");
  if (process.env.SDK_MIXED_API) {
    const crm = client.app("api", { credential: "auth" });
    const phone = client.app("telephony", { credential: "auth" });
    const [record] = await Promise.all([crm.get<{subject:string}>("/crm"), phone.get("/user/calls?auth_provider=login")]);
    if (record.subject !== String(user.id)) throw Error("API returned wrong identity");
    for (const [app, path] of [["api", "/crm"], ["telephony", "/user/calls?auth_provider=login"]]) {
      try { await client.app(app).get(path); throw Error("Platform token accepted as Auth"); }
      catch (error: any) { if (error.status !== 401) throw error; }
    }
  }
  await Promise.all(Array.from({ length: 10 }, () => client.auth.refresh()));
  await client.app("conversations").post("/send", { message: "fixture" });
  await fetch(host + "/fixture/remove-role", { method: "POST" });
  try { await client.auth.refresh(); throw Error("Role downgrade allowed"); }
  catch (error: any) { if (error.status !== 403) throw error; }
  if (!(await client.auth.me()).id) throw Error("Auth session lost after role downgrade");
  if (process.env.SDK_MIXED_API) {
    await client.app("api", { credential: "auth" }).get("/crm");
    await client.app("telephony", { credential: "auth" }).get("/user/calls?auth_provider=login");
    // Revoke this session server-side while the SDK still has its credentials.
    const response = await fetch(host + "/fixture/revoke-session", { method: "POST" });
    if (!response.ok) throw Error("Fixture revocation failed");
    const results = await Promise.allSettled([
      client.app("api", { credential: "auth" }).get("/crm"),
      client.app("telephony", { credential: "auth" }).get("/user/calls?auth_provider=login"),
    ]);
    if (results.some(r => r.status !== "rejected") || client.auth.getSession()) throw Error("Revoked mixed session accepted");
  }
  await client.auth.logout();
  try { await client.app("conversations").get("/chats"); throw Error("Logout allowed requests"); }
  catch (error: any) { if (error.status !== 401) throw error; }
  console.log("Real Auth -> SDK login, renewal, app calls, role downgrade and logout passed." + (process.env.SDK_MIXED_API ? " Real API/Telephony credential routing and revocation passed." : ""));

}
if (process.env.SDK_MIXED_API) await withMixedApps(AptevaClient, host, check);
else await check(client, host);
