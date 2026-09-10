// Real Auth + API JWT validation + Telephony /user routes. Requires an apps checkout.
// Platform mint/protected Conversations gateway remain fixtures; no live accounts.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const apps = resolve(process.env.APTEVA_APPS_DIR || "../apps");
const sdk = resolve(import.meta.dir, "..");
const temp = await mkdtemp(join(tmpdir(), "sdk-mixed-"));
const go = process.env.GO_BINARY || "go";
const env = { ...process.env, GOWORK: "off", GOTOOLCHAIN: "local" };
async function run(args: string[], cwd: string, extra = {}) {
  const p = Bun.spawn([go, ...args], { cwd, env: { ...env, ...extra }, stdout: "inherit", stderr: "inherit" });
  if (await p.exited) throw new Error(`Go command failed in ${cwd}`);
}
try {
  for (const app of ["api", "telephony"]) {
    const cwd = join(apps, "mcp", app);
    const overlay = join(temp, `${app}.json`);
    await writeFile(overlay, JSON.stringify({ Replace: { [join(cwd, "sdk_mixed_fixture_test.go")]: join(sdk, "tests/integration", `${app}_fixture.go.txt`) } }));
    await run(["test", "-overlay", overlay, "-c", "-o", join(temp, app)], cwd);
  }
  await run(["test", "-run", "^TestWebSDKSessionIntegration$", "-count=1", "-v", "-timeout=120s"], join(apps, "mcp/auth"), {
    AUTH_WEB_SDK_TEST_DIR: sdk, SDK_MIXED_API: join(temp, "api"), SDK_MIXED_TELEPHONY: join(temp, "telephony"), SDK_MIXED_APPS: apps,
  });
} finally { await rm(temp, { recursive: true, force: true }); }
