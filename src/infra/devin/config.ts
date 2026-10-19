import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../shared/utils/index.js';
import type { DevinCallOptions } from './types.js';

const log = createLogger('devin-config');

// Print mode cannot show approval prompts, and a mode that would prompt in a
// TUI instead auto-denies the action: `accept-edits` still denies `exec`, and
// `auto` approves read-only tools only. Permission enforcement is therefore
// done through `--config` permission rules — `allow` rules grant `exec` for
// TAKT's `edit` mode (which, per the kiro/cursor mapping, means file edits
// plus shell), while `deny` rules enforce `readonly`.
const READONLY_DENY_RULES = ['exec', 'edit', 'Write(**)', 'mcp__*'] as const;
const STRICT_READONLY_EXTRA_DENY_RULES = ['Fetch(**)'] as const;
const EDIT_ALLOW_RULES = ['exec', 'edit', 'Write(**)'] as const;

function buildReadonlyDenyRules(options: DevinCallOptions): readonly string[] {
  return options.internalAgentIsolation === 'strict-readonly'
    ? [...READONLY_DENY_RULES, ...STRICT_READONLY_EXTRA_DENY_RULES]
    : READONLY_DENY_RULES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

// Mirrors the CLI's own resolution: %APPDATA%\devin\config.json on Windows,
// $XDG_CONFIG_HOME/devin/config.json elsewhere, defaulting to ~/.config.
function resolveDevinUserConfigPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'devin', 'config.json');
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(configHome, 'devin', 'config.json');
}

// Skips whitespace and `//` / `/* */` comments when scanning ahead.
function skipJsoncTrivia(text: string, start: number): number {
  let i = start;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(i + 2, text.length);
      continue;
    }
    return i;
  }
}

// Devin config files support comments and trailing commas (JSONC). Strict
// JSON.parse is tried first; this fallback strips comments and trailing commas
// without touching string literals.
function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1;
      }
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skipJsoncTrivia(text, i);
      continue;
    }
    if (ch === ',') {
      const next = skipJsoncTrivia(text, i + 1);
      if (text[next] === '}' || text[next] === ']') {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function parseUserConfig(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    try {
      const parsed: unknown = JSON.parse(stripJsonc(raw));
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

// `--config` REPLACES the user config file instead of overlaying it, so the
// generated file is seeded from the user's own config to keep model selection
// and their other settings identical across TAKT permission modes. A missing
// or unparseable file starts the merge from an empty object.
async function loadUserConfig(): Promise<Record<string, unknown>> {
  const path = resolveDevinUserConfigPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return {};
  }
  const parsed = parseUserConfig(raw);
  if (parsed === undefined) {
    log.debug('Devin user config could not be parsed; generated --config starts from an empty object', { path });
    return {};
  }
  return parsed;
}

// `shell.setup_complete` suppresses the first-run setup banner that Devin
// otherwise prints to stdout when handed a fresh `--config` file, which would
// pollute the captured response (and break JSON output contracts). TAKT's
// rules are appended to the user's own `permissions` lists; for `full` and
// unset modes no rules are added.
export async function writeGeneratedConfig(dir: string, options: DevinCallOptions): Promise<string> {
  const userConfig = await loadUserConfig();
  const userPermissions = isRecord(userConfig.permissions) ? userConfig.permissions : {};
  const permissions: Record<string, unknown> = { ...userPermissions };
  if (options.permissionMode === 'edit') {
    permissions.allow = [...asStringList(userPermissions.allow), ...EDIT_ALLOW_RULES];
  } else if (options.permissionMode === 'readonly') {
    permissions.deny = [...asStringList(userPermissions.deny), ...buildReadonlyDenyRules(options)];
  }
  const config: Record<string, unknown> = {
    ...userConfig,
    version: userConfig.version ?? 1,
    shell: { ...(isRecord(userConfig.shell) ? userConfig.shell : {}), setup_complete: true },
    permissions,
  };
  const configFilePath = join(dir, 'config.json');
  await writeFile(configFilePath, JSON.stringify(config), 'utf-8');
  return configFilePath;
}
