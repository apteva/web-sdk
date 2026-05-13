import { ApteveClient, pickBaseURL, pickKioskKey } from "@apteva/web-sdk";

declare const __API_BASE__: string;
declare const __TABLES_APP__: string;
declare const __LEADS_TABLE__: string;

// Build-time defaults baked by build.ts. Runtime overrides via
// window.__APTEVA_APP__ (if served by apteva-server itself) win at
// pickBaseURL/pickKioskKey time.
//
// This example is a pure UI: there is no custom sidecar app. The
// "Recent leads" panel reads from a table inside the Tables app
// (default name "leads") via tables.rows_search; the generic table
// browser reads via tables_list + rows_search.
export const TABLES_APP = __TABLES_APP__ || "tables";
export const LEADS_TABLE = __LEADS_TABLE__ || "leads";

export const apteva = new ApteveClient({
  baseURL: pickBaseURL(__API_BASE__),
  apiKey: pickKioskKey(),
  onUnauthorized: () => {
    // 401 → useAuth picks this up via its catch path; nothing to do here
    // beyond the SDK's own throw. Wired for future toast/redirect logic.
  },
});
