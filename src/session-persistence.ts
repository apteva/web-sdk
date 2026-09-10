/** Internal browser persistence. Stored identity/permissions are never trusted. */
export interface StoredSession {
  version: 1;
  scope: string;
  generation: string;
  revision: string;
  state: "active" | "refreshing" | "logged-out";
  refreshToken?: string;
}
export interface PersistenceEnvironment {
  storage: Storage;
  locks: Pick<LockManager, "request">;
  subscribe(key: string, listener: () => void): () => void;
  publish(key: string): void;
  close(): void;
}
export class PersistenceError extends Error {
  constructor(readonly code: "persistence_unavailable" | "invalid_storage" | "refresh_uncertain", message: string) { super(message); }
}

// Storage events exclude the writing document. Keep sibling clients synchronized
// even when BroadcastChannel is unavailable; messages contain only a scope key.
const documentObservers = new Set<(key: string | null) => void>();

function browserEnvironment(): PersistenceEnvironment {
  // Accessing localStorage itself can throw (privacy settings or sandboxed frames).
  const storage = globalThis.localStorage;
  const locks = globalThis.navigator?.locks;
  if (!storage || !locks?.request || !globalThis.addEventListener) throw new Error("Browser storage and Web Locks are required");
  const listeners = new Map<string, Set<() => void>>();
  const dispatch = (key: unknown) => {
    if (key === null) for (const group of listeners.values()) for (const fn of group) fn();
    else if (typeof key === "string") for (const fn of listeners.get(key) ?? []) fn();
  };
  documentObservers.add(dispatch);
  let channel: BroadcastChannel | undefined;
  try { channel = new BroadcastChannel("apteva-auth-session:v1"); } catch { /* Storage events still synchronize tabs. */ }
  if (channel) channel.onmessage = event => { if (event.data?.type === "changed") dispatch(event.data.key); };
  const changed = (event: StorageEvent) => { if (event.storageArea === storage) dispatch(event.key); };
  const focus = () => dispatch(null);
  globalThis.addEventListener("storage", changed);
  globalThis.addEventListener("pageshow", focus);
  globalThis.addEventListener("focus", focus);
  return {
    storage, locks,
    subscribe(key, fn) { const group = listeners.get(key) ?? new Set(); group.add(fn); listeners.set(key, group); return () => group.delete(fn); },
    publish(key) {
      for (const fn of documentObservers) if (fn !== dispatch) queueMicrotask(() => fn(key));
      try { channel?.postMessage({ type: "changed", key }); } catch { /* Storage events remain available. */ }
    },
    close() { documentObservers.delete(dispatch); channel?.close(); globalThis.removeEventListener("storage", changed); globalThis.removeEventListener("pageshow", focus); globalThis.removeEventListener("focus", focus); },
  };
}

export class SessionPersistence {
  readonly key: string;
  readonly scope: string;
  private environment?: PersistenceEnvironment;
  private detach?: () => void;
  constructor(baseURL: string, projectId: string, options: { clientId: string; installId?: number; organizationSlug?: string; profile?: string },
    private readonly changed: () => void, private readonly unavailable: () => void, environment?: PersistenceEnvironment) {
    const server = new URL(baseURL || "/", globalThis.location?.href || "http://localhost");
    if (!/^https?:$/.test(server.protocol) || server.username || server.password || server.search || server.hash) throw new Error("Invalid Auth server URL");
    this.scope = JSON.stringify([server.href.replace(/\/+$/, ""), projectId, options.installId ?? null,
      options.organizationSlug?.trim().toLowerCase() || null, options.clientId, options.profile || null]);
    this.key = "apteva.auth.v1:" + encodeURIComponent(this.scope);
    try {
      this.environment = environment ?? browserEnvironment();
      if (!this.environment.locks?.request) throw new Error("Web Locks required");
      const probe = this.key + ":probe:" + crypto.randomUUID();
      this.environment.storage.setItem(probe, "1"); this.environment.storage.removeItem(probe);
      this.detach = this.environment.subscribe(this.key, changed);
    } catch { this.disable(); }
  }
  get enabled(): boolean { return Boolean(this.environment); }
  disable(): void { this.detach?.(); this.environment?.close(); this.environment = undefined; this.unavailable(); }
  dispose(): void { this.detach?.(); this.environment?.close(); this.environment = undefined; }
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const environment = this.environment;
    if (!environment) throw new PersistenceError("persistence_unavailable", "Persistent sessions are unavailable");
    let entered = false;
    try { return await environment.locks.request(this.key, { mode: "exclusive" }, async () => { entered = true; return fn(); }); }
    catch (error) {
      if (!entered) { this.disable(); throw new PersistenceError("persistence_unavailable", "Session lock unavailable"); }
      throw error;
    }
  }
  read(): StoredSession | undefined {
    let raw: string | null;
    try { if (!this.environment) throw new Error(); raw = this.environment.storage.getItem(this.key); }
    catch { this.disable(); throw new PersistenceError("persistence_unavailable", "Session storage unavailable"); }
    if (raw === null) return undefined;
    try {
      if (raw.length > 20000) throw new Error();
      const record = JSON.parse(raw) as StoredSession;
      if (record.version !== 1 || record.scope !== this.scope || !/^[a-f0-9-]{36}$/.test(record.generation) || !/^[a-f0-9-]{36}$/.test(record.revision) ||
        !["active", "refreshing", "logged-out"].includes(record.state) ||
        (record.state === "logged-out" ? record.refreshToken !== undefined : typeof record.refreshToken !== "string" || record.refreshToken.length < 1 || record.refreshToken.length > 16384)) throw new Error();
      return record;
    } catch { throw new PersistenceError("invalid_storage", "Saved session is invalid; login required"); }
  }
  write(record: StoredSession): void {
    try {
      if (!this.environment) throw new Error();
      this.environment.storage.setItem(this.key, JSON.stringify(record));
      // Storage events do not reach sibling clients in the same document.
      this.environment.publish(this.key);
    } catch { this.disable(); throw new PersistenceError("persistence_unavailable", "Session could not be saved"); }
  }
  record(state: StoredSession["state"], generation: string = crypto.randomUUID(), refreshToken?: string): StoredSession {
    return { version: 1, scope: this.scope, generation, revision: crypto.randomUUID(), state, ...(refreshToken ? { refreshToken } : {}) };
  }
}
