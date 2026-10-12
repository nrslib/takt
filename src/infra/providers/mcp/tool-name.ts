export function parseMcpToolName(tool: string): { serverName: string; toolName: string } | undefined {
  const parts = tool.split('__');
  if (parts.length !== 3 || parts[0] !== 'mcp') return undefined;
  const serverName = parts[1]!;
  const toolName = parts[2]!;
  // 区切りに隣接する _ は、サーバー側とツール側のどちらにも解釈できる。
  if (serverName === '' || toolName === '' || serverName.endsWith('_') || toolName.startsWith('_')) {
    return undefined;
  }
  return { serverName, toolName };
}
