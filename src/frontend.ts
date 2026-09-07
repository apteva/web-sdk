import type { AppHandle } from "./client.js";
import type { AppScope } from "./extensions.js";

export interface FrontendAsset { path: string; sha256: string }
export interface AppFrontendManifest {
  schema: "apteva-app-frontend/v1";
  app: string;
  version: string;
  client: FrontendAsset;
  ui?: FrontendAsset & { reactMajor: number; components: string[] };
  styles?: FrontendAsset;
}
export interface LoadAppOptions extends AppScope {
  /** Omit for headless use. Pass the host's React namespace for components. */
  react?: { version: string; createElement: unknown; [name: string]: unknown };
  clientOptions?: unknown;
  expectedVersion?: string;
  signal?: AbortSignal;
  /** Defaults to the current document when React is supplied. */
  document?: Document;
}
export interface LoadedAppFrontend<TClient = unknown, TComponent = unknown> {
  version: string;
  client: TClient;
  components: Readonly<Record<string, TComponent>>;
  /** Release this mount's stylesheet after unmounting its components. */
  dispose(): void;
}

type ClientModule = { createClient(context: { app: AppHandle }, options?: unknown): unknown };
type UIModule = { createFrontend(runtime: { react: LoadAppOptions["react"] }): { components: Record<string, unknown> } };
const modules = new Map<string, Promise<unknown>>();
const styles = new WeakMap<Document, Map<string, { element: HTMLStyleElement; users: number }>>();

function asset(value: unknown, extension: string): asserts value is FrontendAsset {
  const a = value as FrontendAsset;
  if (!a || typeof a.path !== "string" || !/^\/ui\/[a-zA-Z0-9_./-]+$/.test(a.path) ||
      a.path.slice(1).split("/").some(part => !part || part === "." || part === "..") ||
      !a.path.endsWith(extension) || !/^[a-f0-9]{64}$/.test(a.sha256)) {
    throw new Error("Invalid app frontend asset: expected a hashed, app-local /ui/ path");
  }
}
function manifest(value: unknown, name: string): AppFrontendManifest {
  const m = value as AppFrontendManifest;
  if (!m || m.schema !== "apteva-app-frontend/v1" || m.app !== name || typeof m.version !== "string" || !m.version) {
    throw new Error("Unsupported or mismatched app frontend manifest");
  }
  asset(m.client, ".mjs");
  if (m.ui) {
    asset(m.ui, ".mjs");
    if (!Number.isSafeInteger(m.ui.reactMajor) || m.ui.reactMajor < 1 || !Array.isArray(m.ui.components) ||
        m.ui.components.some(name => typeof name !== "string" || !name || name === "__proto__") || new Set(m.ui.components).size !== m.ui.components.length) {
      throw new Error("Invalid app frontend component declaration");
    }
  }
  if (m.styles) asset(m.styles, ".css");
  return m;
}
async function readAsset(app: AppHandle, entry: FrontendAsset, signal?: AbortSignal): Promise<string> {
  const source = await app.get<string>(`${entry.path}?sha256=${entry.sha256}`, { signal, cache: "force-cache", redirect: "error", headers: { Accept: "text/plain" } });
  if (typeof source !== "string" || source.length > 8 * 1024 * 1024) throw new Error("Invalid or oversized app frontend asset");
  if (!globalThis.crypto?.subtle) throw new Error("App frontend loading requires HTTPS or localhost");
  const bytes = new TextEncoder().encode(source);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
  if (hash !== entry.sha256) throw new Error("App frontend integrity mismatch; retry after the app update finishes");
  signal?.throwIfAborted();
  return source;
}
async function importAsset(app: AppHandle, entry: FrontendAsset, signal?: AbortSignal): Promise<unknown> {
  // The fresh manifest authorizes each load. Immutable asset URLs can use the
  // browser cache; verify their bytes even when the module is already cached.
  const source = await readAsset(app, entry, signal);
  let pending = modules.get(entry.sha256);
  if (!pending) {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    pending = import(/* @vite-ignore */ url).finally(() => URL.revokeObjectURL(url));
    modules.set(entry.sha256, pending);
    pending.catch(() => modules.delete(entry.sha256));
  }
  const loaded = await pending;
  signal?.throwIfAborted();
  return loaded;
}
function mountStyle(doc: Document, hash: string, source: string): () => void {
  let entries = styles.get(doc);
  if (!entries) { entries = new Map(); styles.set(doc, entries); }
  let entry = entries.get(hash);
  if (!entry) {
    const element = doc.createElement("style");
    element.dataset.aptevaFrontend = hash;
    element.textContent = source;
    doc.head.appendChild(element);
    entry = { element, users: 0 }; entries.set(hash, entry);
  }
  entry.users++;
  let disposed = false;
  return () => { if (disposed) return; disposed = true; if (--entry!.users === 0) { entry!.element.remove(); entries!.delete(hash); } };
}

/** Explicitly execute frontend code from a trusted installed app. No npm app package is needed. */
export async function loadAppFrontend<TClient = unknown, TComponent = unknown>(app: AppHandle, options: LoadAppOptions = {}): Promise<LoadedAppFrontend<TClient, TComponent>> {
  if (!app.projectId || !app.installId) throw new Error("App frontend loading requires projectId and installId");
  const spec = manifest(await app.get("/ui/frontend.json", { signal: options.signal, cache: "no-store", redirect: "error" }), app.name);
  if (options.expectedVersion && spec.version !== options.expectedVersion) throw new Error(`App frontend version ${spec.version} does not match ${options.expectedVersion}`);
  if (options.react && (!spec.ui || Number(options.react.version.split(".")[0]) !== spec.ui.reactMajor || typeof options.react.createElement !== "function")) {
    throw new Error(`App frontend requires React ${spec.ui?.reactMajor ?? "UI support"}`);
  }
  const doc = options.react ? options.document ?? globalThis.document : undefined;
  if (options.react && !doc) throw new Error("App frontend UI requires a document");
  // Only metadata must arrive first; independent assets share the next round trip.
  const [clientModule, ui, css] = await Promise.all([
    importAsset(app, spec.client, options.signal) as Promise<ClientModule>,
    options.react ? importAsset(app, spec.ui!, options.signal) as Promise<UIModule> : undefined,
    options.react && spec.styles ? readAsset(app, spec.styles, options.signal) : undefined,
  ]);
  if (typeof clientModule.createClient !== "function") throw new Error("App frontend must export createClient");
  const components: Record<string, unknown> = Object.create(null);
  if (ui) {
    if (typeof ui.createFrontend !== "function") throw new Error("App frontend must export createFrontend");
    const exports = ui.createFrontend({ react: options.react });
    if (!exports || !exports.components) throw new Error("App frontend did not return components");
    for (const name of spec.ui!.components) {
      const component = Object.hasOwn(exports.components, name) ? exports.components[name] : undefined;
      if (!component || (typeof component !== "function" && typeof component !== "object")) throw new Error(`App frontend is missing component ${name}`);
      components[name] = component;
    }
  }
  options.signal?.throwIfAborted();
  const client = await clientModule.createClient({ app }, options.clientOptions) as TClient;
  options.signal?.throwIfAborted();
  const dispose = css !== undefined && doc ? mountStyle(doc, spec.styles!.sha256, css) : () => {};
  return { version: spec.version, client, components: Object.freeze(components) as Readonly<Record<string, TComponent>>, dispose };
}
