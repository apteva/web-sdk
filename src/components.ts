import type { AppHandle } from "./client.js";

/** Matches app-owned component references in chat messages. */
export interface AppComponentReference {
  app: string;
  name: string;
  props?: Record<string, unknown>;
}

/** Metadata from provides.ui_components, as returned by /api/apps. */
export interface AppComponentSpec {
  name: string;
  entry: string;
  slots: string[];
  label?: string;
  description?: string;
  suggested?: boolean;
  visibility?: "attached" | "project";
  refresh_topics?: string[];
  supported_sizes?: string[];
  default_size?: string;
  default_width?: number;
  props_schema?: Record<string, unknown>;
  settings_schema?: Record<string, unknown>;
  preview_props?: Record<string, unknown>;
  native?: { entry: string; schema: string };
}

/** Inject separately from untrusted message props. App handles share live auth. */
export interface AppComponentContext {
  app: AppHandle;
}

/**
 * Explicit local exports only. T may be a React component, a Vue component,
 * or a host-owned loader. This registry does not load or render UI;
 * use apps.load separately for explicit installed-app frontend loading.
 */
export class AppComponentRegistry<T> {
  private readonly apps = new Map<string, Map<string, T>>();

  register(app: string, components: Readonly<Record<string, T>>): () => void {
    if (!app.trim()) throw new Error("component app name must not be empty");
    const entries = Object.entries(components);
    const registered = this.apps.get(app) ?? new Map<string, T>();
    for (const [name] of entries) {
      if (!name.trim()) throw new Error("component name must not be empty");
      if (registered.has(name)) throw new Error(`component already registered: ${app}:${name}`);
    }
    for (const [name, component] of entries) registered.set(name, component);
    this.apps.set(app, registered);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      for (const [name] of entries) registered.delete(name);
      if (!registered.size && this.apps.get(app) === registered) this.apps.delete(app);
    };
  }

  resolve(reference: Pick<AppComponentReference, "app" | "name">): T | undefined {
    return this.apps.get(reference.app)?.get(reference.name);
  }
}
