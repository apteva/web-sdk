import type { AppHandle } from "./client.js";

/** Routing context, never an identity or authorization decision. */
export interface AppScope {
  projectId?: string;
  installId?: number;
}

/** Host-supplied context for app clients and app-owned UI components. */
export interface AppExtensionContext {
  readonly app: AppHandle;
}

/** App packages own their API and may return a Promise for contract validation. */
export interface AppExtension<T> {
  readonly app: string;
  create(context: AppExtensionContext): T;
}

export function defineAppExtension<T>(extension: AppExtension<T>): AppExtension<T> {
  return extension;
}
