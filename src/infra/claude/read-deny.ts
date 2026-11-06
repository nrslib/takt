import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudePermissionsOptions } from '../../core/models/workflow-types.js';
import { warn as printWarning } from '../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';

const log = createLogger('claude-read-deny');

const READ_RULE_PREFIX = 'Read(';

interface ClaudeDenyRuleDeps {
  settingsPath?: string;
  readFile?: (path: string) => string;
  warn?: (message: string) => void;
}

function warnImportFailure(message: string): void {
  log.warn(message);
  printWarning(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns the Read( rules in the user's settings, or a description of why the
 * settings could not be imported. A missing permissions.deny is a normal empty result.
 */
function extractReadDenyRules(parsed: unknown): { rules: string[] } | { problem: string } {
  if (!isRecord(parsed)) {
    return { problem: 'the top-level value is not a JSON object' };
  }
  const permissions = parsed.permissions;
  if (permissions === undefined) {
    return { rules: [] };
  }
  if (!isRecord(permissions)) {
    return { problem: 'permissions is not an object' };
  }
  const deny = permissions.deny;
  if (deny === undefined) {
    return { rules: [] };
  }
  if (!Array.isArray(deny)) {
    return { problem: 'permissions.deny is not an array' };
  }
  return {
    rules: deny.filter((rule): rule is string => typeof rule === 'string' && rule.startsWith(READ_RULE_PREFIX)),
  };
}

function importUserReadDenyRules(deps: ClaudeDenyRuleDeps): string[] {
  const settingsPath = deps.settingsPath ?? join(homedir(), '.claude', 'settings.json');
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf-8'));
  const warn = deps.warn ?? warnImportFailure;
  const skipped = (reason: string): string[] => {
    warn(`Read deny rules were not imported from ${settingsPath}: ${reason}`);
    return [];
  };

  let content: string;
  try {
    content = readFile(settingsPath);
  } catch (error) {
    return skipped(`the file could not be read (${getErrorMessage(error)})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return skipped(`the file is not valid JSON (${getErrorMessage(error)})`);
  }

  const extracted = extractReadDenyRules(parsed);
  return 'problem' in extracted ? skipped(extracted.problem) : extracted.rules;
}

/**
 * Resolves the permissions.deny rules TAKT passes to Claude for one launch:
 * the rules written in the TAKT config plus, when importUserReadDeny is on,
 * the Read( rules from ~/.claude/settings.json. Returns undefined when there
 * is nothing to pass. Never throws: an unusable settings file only produces a warning.
 */
export function resolveClaudeDenyRules(
  permissions: ClaudePermissionsOptions | undefined,
  deps: ClaudeDenyRuleDeps = {},
): string[] | undefined {
  const taktRules = permissions?.deny ?? [];
  const importedRules = permissions?.importUserReadDeny === true ? importUserReadDenyRules(deps) : [];
  const rules = [...new Set([...taktRules, ...importedRules])];
  return rules.length > 0 ? rules : undefined;
}
