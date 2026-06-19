export const TEAM_LEADER_INSPECT_TOOLS = ['read', 'glob', 'grep'] as const;

export type TeamLeaderInspectTool = typeof TEAM_LEADER_INSPECT_TOOLS[number];

export function isTeamLeaderInspectTool(tool: string): tool is TeamLeaderInspectTool {
  return (TEAM_LEADER_INSPECT_TOOLS as readonly string[]).includes(tool);
}

export function formatTeamLeaderInspectTools(): string {
  return TEAM_LEADER_INSPECT_TOOLS.join(', ');
}
