// Run by Auth's TestWebSDKSessionIntegration using a real Auth HTTP handler.
import { AptevaClient } from "../src";
const host = process.env.AUTH_INTEGRATION_URL!;
const client = new AptevaClient({ baseURL: host, projectId: "test-proj", auth: {
  clientId: process.env.AUTH_INTEGRATION_CLIENT!, profile: "commercial",
} });
const user = await client.auth.login({ email: "sdk@example.com", password: "GoodPassword123" });
if (!user.id || !client.auth.getSession()?.platformExpiresAt) throw Error("Missing login/session");
await client.app("conversations").get("/chats");
await Promise.all(Array.from({ length: 10 }, () => client.auth.refresh()));
await client.app("conversations").post("/send", { message: "fixture" });
await fetch(host + "/fixture/remove-role", { method: "POST" });
try { await client.auth.refresh(); throw Error("Role downgrade allowed"); }
catch (error: any) { if (error.status !== 403) throw error; }
if (!(await client.auth.me()).id) throw Error("Auth session lost after role downgrade");
await client.auth.logout();
try { await client.app("conversations").get("/chats"); throw Error("Logout allowed requests"); }
catch (error: any) { if (error.status !== 401) throw error; }
console.log("Real Auth -> SDK login, renewal, app calls, role downgrade and logout passed.");
