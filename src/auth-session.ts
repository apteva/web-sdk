import { SessionPersistence, PersistenceError, type StoredSession, type PersistenceEnvironment } from "./session-persistence.js";
import type { AppCredential } from "./extensions.js";
import { AptevaError } from "./errors.js";
import type { User } from "./types.js";

export interface AuthLoginInput { email: string; password: string }
export interface AuthSignupInput extends AuthLoginInput { displayName?: string }
export interface AuthUser extends User {
  id: number;
  display_name?: string;
  status?: string;
  organization_id?: number;
}
export interface AuthAuthorization {
  roles: string[];
  permissions: string[];
  authorization_version: number;
  [key: string]: unknown;
}
export interface AuthSessionInfo {
  user: AuthUser;
  authorization?: AuthAuthorization;
  expiresAt: string;
  platformExpiresAt?: string;
}
export interface AuthState {
  status: "idle" | "restoring" | "authenticated" | "unauthenticated" | "error";
  persistence: "memory" | "local" | "unavailable";
  error?: { code: string; message: string };
}
export interface AppAuthOptions {
  /** Public Auth app OAuth client identifier; never a private client secret. */
  clientId: string;
  installId?: number;
  organizationSlug?: string;
  /** Requested Auth policy profile. Auth independently checks current roles. */
  profile?: string;
  /** Explicit opt-in. Local persistence requires browser storage and Web Locks. */
  persistence?: "memory" | "local";
  /** Restoration and persistence availability, without credentials. */
  onStateChange?: (state: AuthState) => void;
  /** Receives user/session metadata, never credentials. */
  onSessionChange?: (session: AuthSessionInfo | undefined) => void;
}
interface AuthResponse {
  user: AuthUser;
  authorization?: AuthAuthorization;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  apteva_access_token?: string;
  apteva_expires_in?: number;
  apteva_expires_at?: string;
  verification_required?: boolean;
}
export interface SessionCredential { token: string; epoch: number; revision: number; deadline: number }
interface State { response: AuthResponse; expiresAt: number; platformExpiresAt: number }
const margin = 10_000;

/** Internal issuer-specific session lifecycle. AptevaClient is the public API. */
export class AuthSession {
  private state?: State;
  private persistence?: SessionPersistence;
  private stored?: StoredSession;
  private restoration?: Promise<AuthSessionInfo | undefined>;
  private lifecycle: AuthState = { status: "unauthenticated", persistence: "memory" };
  private disposed = false;
  private epoch = 0;
  private authRevision = 0;
  private platformRevision = 0;
  private pending?: Promise<string>;
  private pendingAuth?: Promise<void>;
  private controllers = new Set<AbortController>();
  private listeners = new Set<() => void>();
  constructor(
    private readonly baseURL: string,
    private readonly projectId: string,
    private readonly options: AppAuthOptions,
    private readonly fetchImpl: typeof fetch,
    private readonly changed: (token: string | undefined) => void,
    environment?: PersistenceEnvironment,
  ) {
    if (options.persistence !== undefined && options.persistence !== "memory" && options.persistence !== "local") throw new Error("Invalid Auth persistence mode");
    if (!projectId || !options.clientId?.trim()) throw new Error("Auth requires projectId and auth.clientId");
    if (options.installId !== undefined && (!Number.isSafeInteger(options.installId) || options.installId < 1)) throw new Error("Invalid Auth installId");
    if (options.persistence === "local") {
      this.lifecycle = { status: "idle", persistence: "local" };
      this.persistence = new SessionPersistence(baseURL, projectId, options, () => this.synchronize(), () => {
        this.lifecycle.persistence = "unavailable"; this.emitState();
      }, environment);
      if (!this.persistence.enabled) this.lifecycle.status = "unauthenticated";
    }
  }
  getState(): AuthState { return structuredClone(this.lifecycle); }
  private emitState(): void { try { this.options.onStateChange?.(this.getState()); } catch { /* Observer only. */ } }
  private status(status: AuthState["status"], error?: unknown): void {
    this.lifecycle = { status, persistence: this.lifecycle.persistence, ...(error ? { error: {
      code: error instanceof PersistenceError ? error.code : error instanceof AptevaError ? `http_${error.status}` : "restoration_failed",
      message: error instanceof PersistenceError ? error.message : "Session restoration failed",
    } } : {}) }; this.emitState();
  }
  private synchronize(): void {
    if (!this.persistence?.enabled || this.disposed) return;
    try {
      const record = this.persistence.read();
      if (record?.generation === this.stored?.generation && record?.state !== "logged-out") {
        if (record?.state === "active" && record.revision !== this.stored?.revision && this.state) {
          this.authRevision++; this.platformRevision++;
          this.state.expiresAt = 0; this.state.platformExpiresAt = 0;
          this.state.response.apteva_access_token = undefined; this.changed(undefined);
        }
        return;
      }
      if (this.stored || this.state) { this.clear(); this.stored = undefined; }
      this.status(record && record.state !== "logged-out" ? "idle" : "unauthenticated");
    } catch (error) { this.clear(); this.status("error", error); }
  }
  private async ready(): Promise<void> {
    if (this.disposed) throw new Error("Auth session disposed");
    if (this.restoration) { await this.restoration; return; }
    this.synchronize();
    if (!this.state && this.lifecycle.status === "idle") await this.restore();
    if (!this.state && this.lifecycle.status === "error") throw new PersistenceError(this.lifecycle.error?.code === "refresh_uncertain" ? "refresh_uncertain" : "invalid_storage", "Restore the session or log in before making requests");
  }
  restore(): Promise<AuthSessionInfo | undefined> {
    if (this.disposed) return Promise.reject(new Error("Auth session disposed"));
    if (this.restoration) return this.restoration;
    if (!this.persistence?.enabled) return Promise.resolve(this.info());
    this.synchronize();
    if (this.state && this.lifecycle.status === "authenticated") return Promise.resolve(this.info());
    const epoch = this.epoch;
    this.status("restoring");
    const pending = this.restoreSaved(epoch);
    this.restoration = pending;
    void pending.finally(() => { if (this.restoration === pending) this.restoration = undefined; }).catch(() => {});
    return pending;
  }
  private async restoreSaved(epoch: number): Promise<AuthSessionInfo | undefined> {
    try {
      await this.persistence!.exclusive(async () => {
        this.assertEpoch(epoch);
        const record = this.persistence!.read();
        if (!record || record.state === "logged-out") { this.status("unauthenticated"); return; }
        await this.refreshSaved(record, epoch);
      });
      this.assertEpoch(epoch); return this.info();
    } catch (error) {
      if (this.epoch === epoch) this.status("error", error);
      throw error;
    }
  }
  dispose(): void { this.disposed = true; this.clear(); this.persistence?.dispose(); }
  info(): AuthSessionInfo | undefined {
    const s = this.state;
    return s ? structuredClone({ user: s.response.user, authorization: s.response.authorization,
      expiresAt: new Date(s.expiresAt).toISOString(),
      platformExpiresAt: s.platformExpiresAt ? new Date(s.platformExpiresAt).toISOString() : undefined }) : undefined;
  }
  onClear(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void {
    try { this.options.onSessionChange?.(this.info()); } catch { /* Observers cannot roll back credential rotation. */ }
  }
  clear(): void {
    this.epoch++;
    this.state = undefined;
    this.pending = undefined;
    this.pendingAuth = undefined;
    this.restoration = undefined;
    this.status("unauthenticated");
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.changed(undefined);
    for (const listener of this.listeners) listener();
    this.notify();
  }
  private assertEpoch(epoch: number): void {
    if (this.epoch !== epoch) throw new AptevaError(401, "Auth session changed");
  }
  private async call<T>(path: string, body?: unknown, token?: string, method = "POST"): Promise<T> {
    const url = new URL(this.baseURL + "/api/apps/auth" + path, globalThis.location?.origin || "http://localhost");
    url.searchParams.set("project_id", this.projectId);
    if (this.options.installId) url.searchParams.set("install_id", String(this.options.installId));
    if (this.options.profile) url.searchParams.set("delegated_profile", this.options.profile);
    const controller = new AbortController(); if (path !== "/logout") this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchImpl(url.toString(), { method, credentials: "omit", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      if (!response.ok) {
        let code: string | undefined;
        if (path === "/refresh") {
          try { const body = await response.json() as { error?: string }; if (["refresh_unavailable", "refresh_uncertain", "invalid_grant"].includes(body.error || "")) code = body.error; } catch { /* Legacy/gateway response. */ }
        }
        if (code === "refresh_uncertain") throw new PersistenceError("refresh_uncertain", "Refresh outcome is uncertain; login required");
        const error = new AptevaError(response.status, path + " failed");
        if (code === "refresh_unavailable") Object.assign(error, { safeRefreshRetry: true });
        throw error;
      }
      return response.status === 204 ? undefined as T : await response.json() as T;
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  private input(body: object): object {
    return { ...body, client_id: this.options.clientId, organization_slug: this.options.organizationSlug };
  }
  private platform(response: Partial<AuthResponse>): { token?: string; expiresAt: number } {
    if (!response.apteva_access_token && response.apteva_expires_at === undefined && response.apteva_expires_in === undefined) return { expiresAt: 0 };
    const expiresAt = Date.parse(response.apteva_expires_at || "");
    const seconds = response.apteva_expires_in;
    // expires_in is measured conservatively from receipt; it also tolerates a
    // client clock offset without ever extending a token beyond 60 seconds.
    if (typeof response.apteva_access_token !== "string" || !response.apteva_access_token || !Number.isFinite(expiresAt) || expiresAt > Date.now() + 61_000 || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new AptevaError(502, "Invalid Auth platform credential expiry");
    return { token: response.apteva_access_token, expiresAt: Math.min(expiresAt, Date.now() + seconds * 1000) };
  }
  private validateResponse(response: AuthResponse): void {
    if (!response.user || !Number.isSafeInteger(response.user.id) || typeof response.access_token !== "string" || !response.access_token || typeof response.refresh_token !== "string" || !response.refresh_token || !Number.isFinite(response.expires_in) || response.expires_in <= 0 || response.expires_in > 86400) throw new AptevaError(502, "Invalid Auth session response");
  }
  private accept(response: AuthResponse, epoch: number, receivedAt: number): void {
    this.assertEpoch(epoch);
    this.validateResponse(response);
    // Save a rotated refresh token before processing the optional platform
    // credential, so a platform outage can never strand the Auth session.
    this.authRevision++; this.platformRevision++;
    this.state = { response: { ...response, apteva_access_token: undefined, apteva_expires_at: undefined, apteva_expires_in: undefined }, expiresAt: receivedAt + response.expires_in * 1000, platformExpiresAt: 0 };
    this.changed(undefined);
    try {
      const platform = this.platform(response);
      this.state.response.apteva_access_token = platform.token;
      this.state.platformExpiresAt = platform.expiresAt;
      this.changed(platform.token);
    } finally { this.status("authenticated"); this.notify(); }
  }
  private async establish(path: string, input: object): Promise<AuthResponse> {
    if (this.disposed) throw new Error("Auth session disposed");
    this.clear(); const epoch = this.epoch;
    const establish = async () => {
      this.assertEpoch(epoch);
      if (this.persistence?.enabled) {
        this.stored = this.persistence.record("logged-out");
        try { this.persistence.write(this.stored); } catch { /* A new login can be memory-only. */ }
      }
      const response = await this.call<AuthResponse>(path, this.input(input));
      this.assertEpoch(epoch);
      if (!response.verification_required) {
        this.validateResponse(response);
        if (this.persistence?.enabled) {
          this.stored = this.persistence.record("active", this.stored!.generation, response.refresh_token);
          try { this.persistence.write(this.stored); } catch { /* New credential stays in memory. */ }
        }
        this.accept(response, epoch, Date.now());
      }
      return response;
    };
    if (!this.persistence?.enabled) return establish();
    try { return await this.persistence.exclusive(establish); }
    catch (error) {
      // A rejected Web Lock request never entered establish(). A fresh login
      // can therefore safely create an independent memory-only session.
      if (error instanceof PersistenceError && error.code === "persistence_unavailable" && !this.persistence.enabled && this.epoch === epoch) return establish();
      throw error;
    }
  }
  async login(input: AuthLoginInput): Promise<AuthUser> { return (await this.establish("/login", input)).user; }
  async register(input: AuthSignupInput): Promise<{ user: AuthUser; verification_required?: boolean }> {
    const response = await this.establish("/signup", { email: input.email, password: input.password, display_name: input.displayName });
    return { user: response.user, verification_required: response.verification_required };
  }
  async logout(): Promise<void> {
    const refresh = this.state?.response.refresh_token;
    let generation = this.stored?.generation;
    if (!generation && this.persistence?.enabled) {
      try { generation = this.persistence.read()?.generation; } catch { /* The locked logout handles invalid/unavailable storage. */ }
    }
    this.clear();
    const logout = async () => {
      let token = refresh;
      if (this.persistence?.enabled) {
        let record: StoredSession | undefined;
        try { record = this.persistence.read(); }
        catch (error) { if (!(error instanceof PersistenceError) || error.code !== "invalid_storage") throw error; }
        // A queued logout from an older login must not clear a newer account.
        if (record && record.generation !== generation) {
          if (token) await this.call("/logout", this.input({ refresh_token: token }));
          return;
        }
        token = record?.refreshToken || token;
        this.stored = this.persistence.record("logged-out");
        this.persistence.write(this.stored);
      }
      if (token) await this.call("/logout", this.input({ refresh_token: token }));
    };
    if (this.persistence?.enabled) await this.persistence.exclusive(logout); else await logout();
  }
  private async refreshSaved(record: StoredSession, epoch: number): Promise<void> {
    const persistence = this.persistence!;
    if (record.state !== "active" || !record.refreshToken) throw new PersistenceError("refresh_uncertain", "Previous refresh did not complete; login required");
    // When the browser already reports offline, do not send or consume anything.
    if (globalThis.navigator?.onLine === false) throw new AptevaError(0, "Browser offline; restoration can be retried");
    const marker = persistence.record("refreshing", record.generation, record.refreshToken);
    this.stored = marker;
    // This durable marker must exist before a single-use credential is sent.
    persistence.write(marker);
    let response: AuthResponse;
    try {
      response = await this.call<AuthResponse>("/refresh", this.input({ refresh_token: record.refreshToken }));
      this.validateResponse(response);
    } catch (error) {
      if (error instanceof AptevaError && error.status === 401) {
        persistence.write(persistence.record("logged-out", record.generation));
        if (this.epoch === epoch) this.clear();
      } else if (error instanceof AptevaError && (error as AptevaError & { safeRefreshRetry?: boolean }).safeRefreshRetry) {
        // Auth explicitly confirms that rotation did not commit.
        persistence.write(record);
      }
      if (error instanceof AptevaError && (error.status === 401 || (error as AptevaError & { safeRefreshRetry?: boolean }).safeRefreshRetry)) throw error;
      // Network failures and generic proxy 5xx responses can hide a committed
      // rotation. Keep the marker; never replay that credential automatically.
      throw new PersistenceError("refresh_uncertain", "Refresh outcome is uncertain; login required");
    }
    this.stored = persistence.record("active", record.generation, response.refresh_token);
    try { persistence.write(this.stored); } catch { /* Marker prevents other tabs reusing the old token. Keep the replacement in memory. */ }
    this.assertEpoch(epoch);
    this.accept(response, epoch, Date.now());
  }
  private async refreshAuth(epoch: number): Promise<void> {
    if (this.pendingAuth) return this.pendingAuth;
    const pending = this.performAuthRefresh(epoch);
    this.pendingAuth = pending;
    try { await pending; } finally { if (this.pendingAuth === pending) this.pendingAuth = undefined; }
  }
  private async performAuthRefresh(epoch: number): Promise<void> {
    if (this.persistence?.enabled) {
      try { await this.persistence.exclusive(async () => {
        this.assertEpoch(epoch);
        const record = this.persistence!.read();
        if (!record || record.state === "logged-out" || (this.stored && record.generation !== this.stored.generation)) {
          this.clear(); throw new AptevaError(401, "Auth session changed");
        }
        await this.refreshSaved(record, epoch);
      }); } catch (error) {
        if (this.epoch === epoch) { this.clear(); this.status("error", error); }
        throw error;
      }
      return;
    }
    const refresh = this.state?.response.refresh_token;
    if (!refresh) throw new AptevaError(401, "Login required");
    try {
      const response = await this.call<AuthResponse>("/refresh", this.input({ refresh_token: refresh }));
      this.accept(response, epoch, Date.now());
    } catch (error) {
      if (this.epoch === epoch && error instanceof AptevaError && error.status === 401) this.clear();
      throw error;
    }
  }
  private async renew(epoch: number, force: boolean): Promise<string> {
    this.assertEpoch(epoch);
    if (!this.state) throw new AptevaError(401, "Login required");
    if (this.state.expiresAt <= Date.now() + margin) await this.refreshAuth(epoch);
    this.assertEpoch(epoch);
    if (!force && this.state!.response.apteva_access_token && this.state!.platformExpiresAt > Date.now() + margin) return this.state!.response.apteva_access_token!;
    let revision = this.authRevision;
    let result: Partial<AuthResponse>;
    try {
      result = await this.call<Partial<AuthResponse>>("/delegated-token", {}, this.state!.response.access_token);
    } catch (error) {
      this.assertEpoch(epoch);
      if (!(error instanceof AptevaError) || error.status !== 401) throw error;
      // Stale Auth roles or an expired Auth access token require normal refresh.
      if (revision === this.authRevision) await this.refreshAuth(epoch);
      this.assertEpoch(epoch);
      revision = this.authRevision;
      if (this.state!.response.apteva_access_token && this.state!.platformExpiresAt > Date.now() + margin) return this.state!.response.apteva_access_token!;
      result = await this.call<Partial<AuthResponse>>("/delegated-token", {}, this.state!.response.access_token);
    }
    if (this.pendingAuth) await this.pendingAuth;
    this.assertEpoch(epoch);
    // A mint started under older Auth permissions must never win over refresh.
    if (revision !== this.authRevision) return this.renew(epoch, false);
    const platform = this.platform(result);
    if (!platform.token || platform.expiresAt <= Date.now()) throw new AptevaError(502, "Missing or expired platform credential");
    this.platformRevision++;
    this.state!.response.apteva_access_token = platform.token;
    this.state!.platformExpiresAt = platform.expiresAt;
    this.changed(platform.token); this.notify(); return platform.token;
  }
  async token(force = false): Promise<string> {
    await this.ready();
    const epoch = this.epoch;
    if (this.pendingAuth) await this.pendingAuth;
    this.assertEpoch(epoch);
    if (this.pending) return this.pending;
    if (!force && this.state?.response.apteva_access_token && this.state.platformExpiresAt > Date.now() + margin) return this.state.response.apteva_access_token;
    const revision = this.authRevision;
    const pending = this.renew(epoch, force).catch(error => {
      if (this.epoch === epoch && this.authRevision === revision && this.state) {
        this.state.response.apteva_access_token = undefined; this.state.platformExpiresAt = 0; this.changed(undefined); this.notify();
      }
      throw error;
    });
    this.pending = pending;
    try { return await pending; } finally { if (this.pending === pending) this.pending = undefined; }
  }
  async me(): Promise<AuthUser> {
    await this.ready();
    if (!this.state) throw new AptevaError(401, "Login required");
    const epoch = this.epoch;
    if (this.state.expiresAt <= Date.now() + margin) await this.refreshAuth(epoch);
    this.assertEpoch(epoch);
    let response: { user: AuthUser; authorization?: AuthAuthorization };
    try {
      response = await this.call<typeof response>("/me", undefined, this.state!.response.access_token, "GET");
    } catch (error) {
      this.assertEpoch(epoch);
      if (!(error instanceof AptevaError) || error.status !== 401) throw error;
      await this.refreshAuth(epoch);
      this.assertEpoch(epoch);
      response = await this.call<typeof response>("/me", undefined, this.state!.response.access_token, "GET");
    }
    this.assertEpoch(epoch);
    this.state!.response.user = response.user; this.state!.response.authorization = response.authorization;
    this.notify(); return response.user;
  }
  async credential(kind: AppCredential): Promise<SessionCredential> {
    await this.ready();
    const epoch = this.epoch;
    for (;;) {
      if (!this.state) throw new AptevaError(401, "Login required");
      if (this.pendingAuth) await this.pendingAuth;
      this.assertEpoch(epoch);
      if (kind === "platform") await this.token();
      else if (this.state!.expiresAt <= Date.now() + margin) await this.refreshAuth(epoch);
      this.assertEpoch(epoch);
      // A refresh can start while token() yields. Take one consistent snapshot
      // only after rotation, including when the refreshed session has no mint.
      if (this.pendingAuth) continue;
      const token = kind === "auth" ? this.state!.response.access_token : this.state!.response.apteva_access_token;
      if (!token) continue;
      return { token, epoch, revision: kind === "auth" ? this.authRevision : this.platformRevision,
        deadline: kind === "auth" ? this.state!.expiresAt : this.state!.platformExpiresAt };
    }
  }
  async recover(kind: AppCredential, used: SessionCredential): Promise<boolean> {
    this.assertEpoch(used.epoch);
    if (!this.state) return false;
    if (kind === "auth") {
      if (used.revision === this.authRevision) await this.refreshAuth(used.epoch);
    } else if (used.revision === this.platformRevision) await this.token(true);
    this.assertEpoch(used.epoch);
    return true;
  }
}
