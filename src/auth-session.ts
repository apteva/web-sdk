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
export interface AppAuthOptions {
  /** Public Auth app OAuth client identifier; never a private client secret. */
  clientId: string;
  installId?: number;
  organizationSlug?: string;
  /** Requested Auth policy profile. Auth independently checks current roles. */
  profile?: string;
  /** Receives user/session metadata, never credentials. Sessions are memory-only. */
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
interface State { response: AuthResponse; expiresAt: number; platformExpiresAt: number }
const margin = 10_000;

/** Internal issuer-specific session lifecycle. AptevaClient is the public API. */
export class AuthSession {
  private state?: State;
  private epoch = 0;
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
  ) {
    if (!projectId || !options.clientId?.trim()) throw new Error("Auth requires projectId and auth.clientId");
    if (options.installId !== undefined && (!Number.isSafeInteger(options.installId) || options.installId < 1)) throw new Error("Invalid Auth installId");
  }
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
      if (!response.ok) throw new AptevaError(response.status, path + " failed");
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
  private accept(response: AuthResponse, epoch: number, receivedAt: number): void {
    this.assertEpoch(epoch);
    if (!response.user || !Number.isSafeInteger(response.user.id) || typeof response.access_token !== "string" || !response.access_token || typeof response.refresh_token !== "string" || !response.refresh_token || !Number.isFinite(response.expires_in) || response.expires_in <= 0 || response.expires_in > 86400) throw new AptevaError(502, "Invalid Auth session response");
    // Save a rotated refresh token before processing the optional platform
    // credential, so a platform outage can never strand the Auth session.
    this.state = { response: { ...response, apteva_access_token: undefined, apteva_expires_at: undefined, apteva_expires_in: undefined }, expiresAt: receivedAt + response.expires_in * 1000, platformExpiresAt: 0 };
    this.changed(undefined);
    try {
      const platform = this.platform(response);
      this.state.response.apteva_access_token = platform.token;
      this.state.platformExpiresAt = platform.expiresAt;
      this.changed(platform.token);
    } finally { this.notify(); }
  }
  async login(input: AuthLoginInput): Promise<AuthUser> {
    this.clear(); const epoch = this.epoch;
    const response = await this.call<AuthResponse>("/login", this.input(input));
    this.accept(response, epoch, Date.now()); return response.user;
  }
  async register(input: AuthSignupInput): Promise<{ user: AuthUser; verification_required?: boolean }> {
    this.clear(); const epoch = this.epoch;
    const response = await this.call<AuthResponse>("/signup", this.input({ email: input.email, password: input.password, display_name: input.displayName }));
    this.assertEpoch(epoch);
    if (!response.verification_required) this.accept(response, epoch, Date.now());
    return { user: response.user, verification_required: response.verification_required };
  }
  async logout(): Promise<void> {
    const refresh = this.state?.response.refresh_token;
    this.clear();
    if (refresh) await this.call("/logout", this.input({ refresh_token: refresh }));
  }
  private async refreshAuth(epoch: number): Promise<void> {
    if (this.pendingAuth) return this.pendingAuth;
    const pending = this.performAuthRefresh(epoch);
    this.pendingAuth = pending;
    try { await pending; } finally { if (this.pendingAuth === pending) this.pendingAuth = undefined; }
  }
  private async performAuthRefresh(epoch: number): Promise<void> {
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
    let result: Partial<AuthResponse>;
    try {
      result = await this.call<Partial<AuthResponse>>("/delegated-token", {}, this.state!.response.access_token);
    } catch (error) {
      this.assertEpoch(epoch);
      if (!(error instanceof AptevaError) || error.status !== 401) throw error;
      // Stale Auth roles or an expired Auth access token require normal refresh.
      await this.refreshAuth(epoch);
      this.assertEpoch(epoch);
      if (this.state!.response.apteva_access_token && this.state!.platformExpiresAt > Date.now() + margin) return this.state!.response.apteva_access_token!;
      result = await this.call<Partial<AuthResponse>>("/delegated-token", {}, this.state!.response.access_token);
    }
    this.assertEpoch(epoch);
    const platform = this.platform(result);
    if (!platform.token || platform.expiresAt <= Date.now()) throw new AptevaError(502, "Missing or expired platform credential");
    this.state!.response.apteva_access_token = platform.token;
    this.state!.platformExpiresAt = platform.expiresAt;
    this.changed(platform.token); this.notify(); return platform.token;
  }
  async token(force = false): Promise<string> {
    if (this.pending) return this.pending;
    if (!force && this.state?.response.apteva_access_token && this.state.platformExpiresAt > Date.now() + margin) return this.state.response.apteva_access_token;
    if (this.pending) return this.pending;
    const epoch = this.epoch;
    const pending = this.renew(epoch, force).catch(error => {
      if (this.epoch === epoch && this.state) {
        this.state.response.apteva_access_token = undefined; this.state.platformExpiresAt = 0; this.changed(undefined); this.notify();
      }
      throw error;
    });
    this.pending = pending;
    try { return await pending; } finally { if (this.pending === pending) this.pending = undefined; }
  }
  async me(): Promise<AuthUser> {
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
  platformDeadline(): number { return this.state?.platformExpiresAt || 0; }
}
