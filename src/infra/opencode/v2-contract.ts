export const TAKT_V2_PLUGIN_ID = 'takt.session';
export const TAKT_V2_METADATA_KEY = 'takt';

export function toV2ToolName(name: string): string {
  switch (name) {
    case 'bash': return 'shell';
    case 'task': return 'subagent';
    case 'apply_patch': return 'patch';
    default: return name;
  }
}

export function fromV2ToolName(name: string): string {
  switch (name) {
    case 'shell': return 'bash';
    case 'subagent': return 'task';
    default: return name;
  }
}

export function toV2Tools(tools: Readonly<Record<string, boolean>>): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const [name, enabled] of Object.entries(tools)) {
    const v2Name = toV2ToolName(name);
    result[v2Name] = result[v2Name] === true || enabled;
  }
  return result;
}
