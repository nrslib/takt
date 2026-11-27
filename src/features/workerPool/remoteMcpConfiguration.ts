import { McpServerEntrySchema } from '../../infra/config/runtime-provider/mcp-schema.js';
import { isMcpCredentialFlag, isMcpCredentialKey, parseMcpFlag } from '../../infra/config/runtime-provider/mcp-credential-fields.js';

function requireReference(value: string): void {
  const remainder = value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, '');
  if (remainder === value || remainder !== '') {
    throw new Error('Remote MCP configuration contains a fixed or malformed authentication value');
  }
}

function requireHeaderReference(name: string, value: string): void {
  let position = 0;
  for (const match of value.matchAll(/\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}/g)) {
    const literal = value.slice(position, match.index);
    // Only Authorization has an authentication scheme before the first credential.
    const allowed = position === 0
      ? literal === '' || (name.toLowerCase() === 'authorization' && /^[!#$%&'*+.^_`|~A-Za-z0-9-]+[ \t]+$/.test(literal))
      : /^[ \t:]*$/.test(literal);
    if (!allowed) throw new Error('Remote MCP configuration contains a fixed or malformed authentication value');
    position = match.index + match[0].length;
  }
  if (position === 0 || position !== value.length) {
    throw new Error('Remote MCP configuration contains a fixed or malformed authentication value');
  }
}

function validateServer(value: unknown): void {
  const parsed = McpServerEntrySchema.safeParse(value);
  if (!parsed.success) throw new Error('Remote MCP server configuration is invalid');
  const server = parsed.data;
  if ('command' in server) {
    for (const [key, entry] of Object.entries(server.env ?? {})) if (isMcpCredentialKey(key)) requireReference(entry);
    const args = server.args ?? [];
    for (let index = 0; index < args.length; index++) {
      const flag = parseMcpFlag(args[index]!);
      if (flag === undefined || !isMcpCredentialFlag(flag.name)) continue;
      const entry = flag.inlineValue ?? args[++index];
      requireReference(entry ?? '');
    }
    return;
  }
  const authority = /^[^/?#]*:\/\/([^/?#]*)/.exec(server.url)?.[1];
  const userinfo = authority === undefined || !authority.includes('@') ? undefined : authority.slice(0, authority.lastIndexOf('@'));
  if (userinfo !== undefined) {
    const separator = userinfo.indexOf(':');
    requireReference(decodeURIComponent(separator < 0 ? userinfo : userinfo.slice(0, separator)));
    if (separator >= 0) requireReference(decodeURIComponent(userinfo.slice(separator + 1)));
  }
  const fragmentStart = server.url.indexOf('#');
  const beforeFragment = fragmentStart < 0 ? server.url : server.url.slice(0, fragmentStart);
  const queryStart = beforeFragment.indexOf('?');
  const query = queryStart < 0 ? '' : beforeFragment.slice(queryStart + 1);
  const fragment = fragmentStart < 0 ? '' : server.url.slice(fragmentStart + 1);
  for (const component of [query, ...fragment.split(/[?#]/u)]) {
    for (const [key, entry] of new URLSearchParams(component)) if (isMcpCredentialKey(key)) requireReference(entry);
  }
  for (const [key, entry] of Object.entries(server.headers ?? {})) if (isMcpCredentialKey(key)) requireHeaderReference(key, entry);
}

/** Keep unexpanded MCP references while rejecting secrets before durable input is created. */
export function portableRemoteConfiguration(value: unknown, key = ''): unknown {
  if (key === 'mcpServers' || key === 'mcp') {
    if (value === undefined) return value;
    const servers = key === 'mcp' ? (value as { servers?: Record<string, unknown> }).servers : value;
    for (const server of Object.values(servers ?? {})) validateServer(server);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => portableRemoteConfiguration(entry));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) =>
    !/(?:api_?key|password|secret|authorization|access_?token|refresh_?token|github_?token|bot_?token|app_?token|^token)$/i.test(name))
    .map(([name, entry]) => [name, portableRemoteConfiguration(entry, name)]));
}
