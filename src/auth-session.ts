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
export type AuthStateReason = "refresh_retryable" | "refresh_uncertain" | "invalid_session" | "logout" | "revoked" | "storage_error" | "session_changed";
export type AuthDiagnosticTrigger = "offline" | "timeout" | "http" | "network" | "persistence" | "unresolved_marker";
export interface AuthState {
  status: "idle" | "restoring" | "authenticated" | "unauthenticated" | "error";
  persistence: "memory" | "local" | "unavailable";
  /** Authenticated can retain identity while fresh credentials are blocked. */
  reason?: AuthStateReason;
  recovery?: "retry" | "login";
  error?: { code: string; message: string; trigger?: AuthDiagnosticTrigger; httpStatus?: number };
}
/** Credential-free lifecycle events suitable for client telemetry. */
export type AuthDiagnostic =
  | { type: "refresh"; outcome: "succeeded" | "retryable" | "uncertain" | "invalid" | "revoked" | "blocked"; trigger?: AuthDiagnosticTrigger; httpStatus?: number }
  | { type: "session_clear"; reason: "login" | "logout" | "dispose" | "shared_change" | "invalid_refresh" | "revoked" | "refresh_uncertain" | "storage_error" };
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
  /** Receives fixed outcome and reason codes, never credentials or server text. */
  onDiagnostic?: (event: AuthDiagnostic) => void;
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
class RefreshFailure extends AptevaError {
  constructor(readonly outcome: "retryable" | "uncertain" | "invalid" | "revoked", readonly trigger: AuthDiagnosticTrigger,
    status: number, message: string, readonly httpStatus?: number) { super(status, message); }
}
const retryableRefresh = (error: unknown): error is RefreshFailure & { outcome: "retryable" } => error instanceof RefreshFailure && error.outcome === "retryable";
const invalidRefresh = (error: unknown): error is RefreshFailure & { outcome: "invalid" | "revoked" } => error instanceof RefreshFailure && (error.outcome === "invalid" || error.outcome === "revoked");

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
  private refreshBlock?: RefreshFailure | PersistenceError;
  private recoveryFailure?: RefreshFailure | PersistenceError;
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
  private diagnostic(event: AuthDiagnostic): void { try { this.options.onDiagnostic?.(event); } catch { /* Observer only. */ } }
  private emitState(): void { try { this.options.onStateChange?.(this.getState()); } catch { /* Observer only. */ } }
  private status(status: AuthState["status"], error?: unknown, reason?: AuthStateReason, recovery?: AuthState["recovery"]): void {
    this.lifecycle = { status, persistence: this.lifecycle.persistence, ...(error ? { error: {
      code: error instanceof RefreshFailure && error.outcome === "uncertain" ? "refresh_uncertain" : error instanceof PersistenceError ? error.code : error instanceof AptevaError ? `http_${error.status}` : "restoration_failed",
      message: error instanceof PersistenceError ? error.message : "Session restoration failed",
      ...(error instanceof RefreshFailure ? { trigger: error.trigger, ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}) }
        : error instanceof PersistenceError ? { trigger: "persistence" as const } : {}),
    } } : {}), ...(reason ? { reason } : {}), ...(recovery ? { recovery } : {}) }; this.emitState();
  }
  private failedRefresh(error: RefreshFailure | PersistenceError, epoch: number): void {
    if (this.epoch !== epoch) return;
    this.recoveryFailure = error;
    if (invalidRefresh(error)) {
      this.clear(error.outcome === "revoked" ? "revoked" : "invalid_refresh");
      this.stored = undefined;
    } else {
      const retryable = retryableRefresh(error);
      if (!retryable) this.refreshBlock = error;
      const reason = error instanceof PersistenceError ? "storage_error" : retryable ? "refresh_retryable" : "refresh_uncertain";
      this.status(this.state ? "authenticated" : "error", error, reason, retryable ? "retry" : "login");
    }
    this.diagnostic({ type: "refresh", outcome: error instanceof RefreshFailure ? error.outcome : "blocked",
      trigger: error instanceof RefreshFailure ? error.trigger : "persistence",
      ...(error instanceof RefreshFailure && error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}) });
  }
  private synchronize(): void {
    if (!this.persistence?.enabled || this.disposed) return;
    try {
      const record = this.persistence.read();
      if (record?.generation === this.stored?.generation && record?.state !== "logged-out") {
        if (record?.state === "active" && record.revision !== this.stored?.revision) {
          this.refreshBlock = undefined; this.recoveryFailure = undefined;
          if (!this.state) { this.stored = record; this.status("idle"); return; }
          this.authRevision++; this.platformRevision++;
          this.state.expiresAt = 0; this.state.platformExpiresAt = 0;
          this.state.response.apteva_access_token = undefined; this.changed(undefined);
          this.stored = record;
          this.status("authenticated");
        }
        return;
      }
      const reason = record?.state === "logged-out" ? record.reason ?? "session_changed" : "session_changed";
      if (this.stored || this.state) {
        this.clear(reason === "logout" ? "logout" : reason === "invalid_session" ? "invalid_refresh" : reason === "revoked" ? "revoked" : "shared_change");
        this.stored = undefined;
      }
      this.status(record && record.state !== "logged-out" ? "idle" : "unauthenticated", undefined,
        record?.state === "logged-out" ? reason : undefined, reason === "invalid_session" || reason === "revoked" ? "login" : undefined);
    } catch (error) {
      this.failedRefresh(error instanceof PersistenceError ? error : new PersistenceError("invalid_storage", "Session storage unavailable"), this.epoch);
    }
  }
  private async ready(): Promise<void> {
    if (this.disposed) throw new Error("Auth session disposed");
    if (this.restoration) { await this.restoration; return; }
    this.synchronize();
    if (!this.state && this.lifecycle.status === "idle") await this.restore();
    if (!this.state && this.lifecycle.status === "error") throw this.recoveryFailure ?? new PersistenceError("invalid_storage", "Restore the session or log in before making requests");
  }
  restore(): Promise<AuthSessionInfo | undefined> {
    if (this.disposed) return Promise.reject(new Error("Auth session disposed"));
    if (this.restoration) return this.restoration;
    if (this.pendingAuth) return this.pendingAuth.then(() => this.info());
    if (!this.persistence?.enabled) {
      if (this.refreshBlock) return Promise.reject(this.refreshBlock);
      if (this.state && this.lifecycle.reason === "refresh_retryable") return this.refreshAuth(this.epoch).then(() => this.info());
      return Promise.resolve(this.info());
    }
    this.synchronize();
    if (this.state && this.lifecycle.status === "authenticated" && !this.lifecycle.reason) return Promise.resolve(this.info());
    const epoch = this.epoch;
    this.status("restoring");
    const pending = this.restoreSaved(epoch);
    this.restoration = pending;
    void pending.finally(() => { if (this.restoration === pending) this.restoration = undefined; }).catch(() => {});
    return pending;
  }
  private async restoreSaved(epoch: number): Promise<AuthSessionInfo | undefined> {
    let entered = false;
    try {
      await this.persistence!.exclusive(async () => {
        entered = true;
        this.assertEpoch(epoch);
        let record: StoredSession | undefined;
        try { record = this.persistence!.read(); }
        catch (error) {
          if (error instanceof PersistenceError) this.failedRefresh(error, epoch);
          throw error;
        }
        if (!record || record.state === "logged-out") {
          this.status("unauthenticated", undefined, record?.reason,
            record?.reason === "invalid_session" || record?.reason === "revoked" ? "login" : undefined); return;
        }
        await this.refreshSaved(record, epoch);
      });
      this.assertEpoch(epoch); return this.info();
    } catch (error) {
      if (!entered && error instanceof PersistenceError) this.failedRefresh(error, epoch);
      throw error;
    }
  }
  dispose(): void { this.disposed = true; this.clear("dispose"); this.persistence?.dispose(); }
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
  clear(reason: Extract<AuthDiagnostic, { type: "session_clear" }>["reason"] = "shared_change"): void {
    const hadSession = Boolean(this.state || (this.stored && this.stored.state !== "logged-out"));
    this.epoch++;
    this.state = undefined;
    this.refreshBlock = undefined; this.recoveryFailure = undefined;
    this.pending = undefined;
    this.pendingAuth = undefined;
    this.restoration = undefined;
    this.status("unauthenticated", undefined, reason === "logout" ? "logout" : reason === "invalid_refresh" ? "invalid_session"
      : reason === "revoked" ? "revoked" : "session_changed", reason === "invalid_refresh" || reason === "revoked" ? "login" : undefined);
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.changed(undefined);
    for (const listener of this.listeners) listener();
    this.notify();
    if (hadSession) this.diagnostic({ type: "session_clear", reason });
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
    let timedOut = false;
    let httpStatus: number | undefined;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    try {
      const response = await this.fetchImpl(url.toString(), { method, credentials: "omit", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      httpStatus = response.status;
      if (!response.ok) {
        let code: string | undefined;
        if (path === "/refresh") {
          try { const body = await response.json() as { error?: string }; if (["refresh_unavailable", "refresh_uncertain", "invalid_grant", "session_revoked"].includes(body.error || "")) code = body.error; } catch { /* Legacy/gateway response. */ }
        }
        if (path === "/refresh") {
          const outcome = response.status === 503 && code === "refresh_unavailable" ? "retryable"
            : response.status === 401 && code === "invalid_grant" ? "invalid"
            : response.status === 401 && code === "session_revoked" ? "revoked" : "uncertain";
          throw new RefreshFailure(outcome, "http", response.status, "Auth refresh failed", response.status);
        }
        throw new AptevaError(response.status, path + " failed");
      }
      return response.status === 204 ? undefined as T : await response.json() as T;
    } catch (error) {
      if (path === "/refresh" && !(error instanceof RefreshFailure)) {
        throw new RefreshFailure("uncertain", timedOut ? "timeout" : httpStatus !== undefined ? "http" : "network", httpStatus === undefined ? 0 : 502, "Refresh outcome is uncertain; login required", httpStatus);
      }
      throw error;
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
    this.refreshBlock = undefined; this.recoveryFailure = undefined;
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
    this.clear("login"); const epoch = this.epoch;
    const establish = async () => {
      this.assertEpoch(epoch);
      if (this.persistence?.enabled) {
        this.stored = this.persistence.record("logged-out", undefined, undefined, "session_changed");
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
    this.clear("logout");
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
        this.stored = this.persistence.record("logged-out", undefined, undefined, "logout");
        this.persistence.write(this.stored);
      }
      if (token) await this.call("/logout", this.input({ refresh_token: token }));
    };
    if (this.persistence?.enabled) await this.persistence.exclusive(logout); else await logout();
  }
  private async refreshSaved(record: StoredSession, epoch: number): Promise<void> {
    const persistence = this.persistence!;
    this.stored = record;
    let marker: StoredSession | undefined;
    let response: AuthResponse;
    try {
      if (record.state !== "active" || !record.refreshToken) throw new RefreshFailure("uncertain", "unresolved_marker", 0, "Previous refresh did not complete; login required");
      // Offline before sending is known not to consume the refresh credential.
      if (globalThis.navigator?.onLine === false) throw new RefreshFailure("retryable", "offline", 0, "Browser offline; refresh can be retried");
      marker = persistence.record("refreshing", record.generation, record.refreshToken);
      this.stored = marker;
      persistence.write(marker);
      response = await this.call<AuthResponse>("/refresh", this.input({ refresh_token: record.refreshToken }));
      try { this.validateResponse(response); }
      catch { throw new RefreshFailure("uncertain", "http", 502, "Invalid Auth refresh response", 200); }
    } catch (error) {
      const failure = error instanceof RefreshFailure || error instanceof PersistenceError ? error
        : new RefreshFailure("uncertain", "network", 0, "Refresh outcome is uncertain; login required");
      // Process the failure before releasing the lock: queued tabs may establish
      // a newer session as soon as it is released.
      try {
        if (marker && (retryableRefresh(failure) || invalidRefresh(failure))) {
          const current = persistence.read();
          if (current?.revision !== marker.revision) throw new AptevaError(401, "Auth session changed");
          const replacement = retryableRefresh(failure) ? record : persistence.record("logged-out", record.generation, undefined,
            failure.outcome === "revoked" ? "revoked" : "invalid_session");
          persistence.write(replacement);
          if (retryableRefresh(failure)) this.stored = replacement;
        }
      } catch (storageError) {
        if (invalidRefresh(failure)) {
          // A failed tombstone save cannot make a definitively rejected local
          // credential valid again. The shared marker still prevents replay.
          this.failedRefresh(failure, epoch);
          if (storageError instanceof PersistenceError) this.diagnostic({ type: "refresh", outcome: "blocked", trigger: "persistence" });
          throw failure;
        }
        if (storageError instanceof PersistenceError) this.failedRefresh(storageError, epoch);
        throw storageError;
      }
      this.failedRefresh(failure, epoch);
      throw failure;
    }
    const replacement = persistence.record("active", record.generation, response.refresh_token);
    // Preserve a successful rotation in memory if storage disappears. The
    // durable marker still prevents siblings from replaying its predecessor.
    let saveError: PersistenceError | undefined;
    try {
      if (persistence.read()?.revision !== marker!.revision) throw new AptevaError(401, "Auth session changed");
      persistence.write(replacement);
    } catch (error) {
      if (!(error instanceof PersistenceError)) throw error;
      saveError = error;
    }
    this.stored = replacement;
    this.assertEpoch(epoch);
    this.accept(response, epoch, Date.now());
    this.diagnostic({ type: "refresh", outcome: "succeeded" });
    if (saveError) this.diagnostic({ type: "refresh", outcome: "blocked", trigger: "persistence" });
  }
  private async refreshAuth(epoch: number): Promise<void> {
    if (this.pendingAuth) return this.pendingAuth;
    const pending = this.performAuthRefresh(epoch);
    this.pendingAuth = pending;
    try { await pending; } finally { if (this.pendingAuth === pending) this.pendingAuth = undefined; }
  }
  private async performAuthRefresh(epoch: number): Promise<void> {
    this.assertEpoch(epoch);
    if (this.refreshBlock) throw this.refreshBlock;
    if (this.persistence?.enabled) {
      let entered = false;
      try { await this.persistence.exclusive(async () => {
        entered = true;
        this.assertEpoch(epoch);
        let record: StoredSession | undefined;
        try { record = this.persistence!.read(); }
        catch (error) {
          if (error instanceof PersistenceError) this.failedRefresh(error, epoch);
          throw error;
        }
        if (!record || record.state === "logged-out" || (this.stored && record.generation !== this.stored.generation)) {
          this.synchronize();
          if (this.epoch === epoch) this.clear("shared_change");
          throw new AptevaError(401, "Auth session changed");
        }
        await this.refreshSaved(record, epoch);
      }); } catch (error) {
        if (!entered && error instanceof PersistenceError) this.failedRefresh(error, epoch);
        throw error;
      }
      return;
    }
    const refresh = this.state?.response.refresh_token;
    if (!refresh) throw new AptevaError(401, "Login required");
    let response: AuthResponse;
    try {
      if (globalThis.navigator?.onLine === false) throw new RefreshFailure("retryable", "offline", 0, "Browser offline; refresh can be retried");
      response = await this.call<AuthResponse>("/refresh", this.input({ refresh_token: refresh }));
      try { this.validateResponse(response); }
      catch { throw new RefreshFailure("uncertain", "http", 502, "Invalid Auth refresh response", 200); }
    } catch (error) {
      const failure = error instanceof RefreshFailure ? error : new RefreshFailure("uncertain", "network", 0, "Refresh outcome is uncertain; login required");
      this.failedRefresh(failure, epoch);
      throw failure;
    }
    this.accept(response, epoch, Date.now());
    this.diagnostic({ type: "refresh", outcome: "succeeded" });
  }
  private async renew(epoch: number, force: boolean): Promise<string> {
    this.assertEpoch(epoch);
    if (!this.state) throw new AptevaError(401, "Login required");
    if (this.refreshBlock) throw this.refreshBlock;
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
    if (this.refreshBlock) throw this.refreshBlock;
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
      if (this.epoch === epoch && this.authRevision === revision && this.state &&
        (!(error instanceof RefreshFailure || error instanceof PersistenceError) || this.state.platformExpiresAt <= Date.now())) {
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
