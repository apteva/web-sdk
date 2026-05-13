import type { AptevaAppInjection } from "./types.js";

// Returns the apteva-server injection block if this UI is being served
// as a static app on the platform itself (apps_static.go writes a
// <script>window.__APTEVA_APP__ = …</script> into the served HTML).
// Returns undefined in any other environment (Vercel-hosted UI, Node,
// SSR pre-hydrate, jsdom without seeding). Safe to call during module
// init — guards against `window` being absent.
export function readAptevaInjection(): AptevaAppInjection | undefined {
  if (typeof window === "undefined") return undefined;
  return window.__APTEVA_APP__;
}

// Picks the API key to authenticate with, in precedence order:
//   1. ?api_key=… in the URL — shareable kiosk links override everything
//   2. install-config kiosk_api_key from window.__APTEVA_APP__
//   3. explicit fallback passed by the caller (e.g. process.env.X)
// Returns undefined when none are set; the caller then falls back to
// cookie auth.
export function pickKioskKey(fallback?: string): string | undefined {
  if (typeof window !== "undefined") {
    try {
      const url = new URL(window.location.href);
      const k = url.searchParams.get("api_key");
      if (k) return k;
    } catch {}
    const inj = window.__APTEVA_APP__;
    if (inj?.kiosk_api_key) return inj.kiosk_api_key;
  }
  return fallback;
}

// Resolves the base URL the client should hit. Precedence:
//   1. explicit arg — caller wins
//   2. window.__API_BASE__ — legacy injection still respected
//   3. window.__APTEVA_APP__.api_base
//   4. same-origin "" — fetch() falls back to the current document origin
export function pickBaseURL(explicit?: string): string {
  if (explicit) return explicit;
  if (typeof window !== "undefined") {
    if (typeof window.__API_BASE__ === "string" && window.__API_BASE__) {
      return originFromApiBase(window.__API_BASE__);
    }
    const inj = window.__APTEVA_APP__;
    if (inj?.api_base) return originFromApiBase(inj.api_base);
  }
  return "";
}

// __API_BASE__ is historically "/api"; the SDK adds /api itself, so we
// strip a trailing /api so concatenation doesn't double-suffix.
function originFromApiBase(s: string): string {
  if (s === "/api") return "";
  if (s.endsWith("/api")) return s.slice(0, -4);
  return s;
}
