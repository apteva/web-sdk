import { AptevaError } from "./errors.js";
import type { AppComponentSpec } from "./components.js";

/** Relevant fields of the existing platform /api/apps response. */
export interface InstalledApp {
  install_id: number;
  name: string;
  version: string;
  project_id: string;
  status: string;
  display_name?: string;
  source?: string;
  ui_components?: AppComponentSpec[];
  surfaces?: {
    mcp_tool_names?: string[];
    http_routes?: string[];
  };
}

export interface AppRequirements {
  app: string;
  /** App packages choose their version policy; no implied wire/API version. */
  version?: { description: string; accepts(version: string): boolean };
  tools?: readonly string[];
  components?: readonly string[];
}

export interface AppCompatibility {
  compatible: boolean;
  issues: string[];
}

/** Checks advertised metadata only. This never grants access to an app. */
export function checkAppCompatibility(
  installed: InstalledApp | undefined,
  requirements: AppRequirements,
): AppCompatibility {
  const issues: string[] = [];
  if (!installed) {
    issues.push(`app ${requirements.app} is not installed`);
  } else {
    if (installed.name !== requirements.app) issues.push(`expected app ${requirements.app}, got ${installed.name}`);
    if (requirements.version && !requirements.version.accepts(installed.version)) {
      issues.push(`version ${installed.version} does not satisfy ${requirements.version.description}`);
    }
    for (const tool of requirements.tools ?? []) {
      if (!installed.surfaces?.mcp_tool_names?.includes(tool)) issues.push(`missing tool: ${tool}`);
    }
    for (const name of requirements.components ?? []) {
      if (!installed.ui_components?.some((component) => component.name === name)) issues.push(`missing component: ${name}`);
    }
  }
  return { compatible: issues.length === 0, issues };
}

export function assertAppCompatibility(
  installed: InstalledApp | undefined,
  requirements: AppRequirements,
): void {
  const result = checkAppCompatibility(installed, requirements);
  if (!result.compatible) throw new AptevaError(0, `incompatible app: ${result.issues.join("; ")}`);
}
