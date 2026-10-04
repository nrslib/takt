export interface ToolkitManifest {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  [key: string]: unknown;
}
export function prepareToolkitManifest(manifest: ToolkitManifest, resolvedVersion: string): ToolkitManifest;
