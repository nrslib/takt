import { isSensitiveKeyName } from '../../../shared/utils/sensitiveText.js';

const MCP_FLAG_NAME_PATTERN = /^--?[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const MCP_CREDENTIAL_FLAG_NAMES = new Set([
  'access-key',
  'access-token',
  'api-key',
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'credential',
  'credentials',
  'cookie',
  'cookies',
  'header',
  'headers',
  'key',
  'password',
  'passphrase',
  'pass-phrase',
  'private-key',
  'proxy-authorization',
  'refresh-token',
  'secret',
  'session-id',
  'set-cookie',
  'token',
  'user',
  'proxy-user',
]);
const MCP_CREDENTIAL_FLAG_SUFFIXES = [
  '-apikey',
  '-auth',
  '-authorization',
  '-bearer',
  '-cookie',
  '-cookies',
  '-credential',
  '-credentials',
  '-header',
  '-headers',
  '-key',
  '-pass-phrase',
  '-passphrase',
  '-password',
  '-secret',
  '-session-id',
  '-token',
] as const;
const MCP_CREDENTIAL_KEY_NAMES = new Set([
  'auth',
  'authorization',
  'bearer',
  'credential',
  'credentials',
  'cookie',
  'cookies',
  'header',
  'headers',
  'key',
  'password',
  'passphrase',
  'pass-phrase',
  'secret',
  'session-id',
  'set-cookie',
  'token',
]);
const MCP_CREDENTIAL_KEY_SUFFIXES = [
  '-apikey',
  '-api-key',
  '-auth',
  '-auth-header',
  '-authorization',
  '-authorization-header',
  '-bearer',
  '-cookie',
  '-cookies',
  '-credential',
  '-credentials',
  '-key',
  '-pass-phrase',
  '-passphrase',
  '-password',
  '-secret',
  '-session-id',
  '-token',
] as const;

function normalizeMcpFlagName(flag: string): string {
  return flag.replace(/^-+/u, '').replaceAll('_', '-').toLowerCase();
}

export function isMcpCredentialFlag(flag: string): boolean {
  // Only the standard compact credential aliases are protected. Generic
  // short options such as -k, -p, -t, and -A are command-specific. Curl's
  // -uVALUE/-UVALUE forms are intentionally parsed as compact credentials;
  // this makes -url unavoidably ambiguous with -u + "rl".
  if (/^-[^-]/u.test(flag)) return flag === '-H' || flag === '-u' || flag === '-U';
  const normalized = normalizeMcpFlagName(flag);
  return MCP_CREDENTIAL_FLAG_NAMES.has(normalized)
    || MCP_CREDENTIAL_FLAG_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function normalizeMcpKeyName(key: string): string {
  return key.trim().replaceAll('_', '-').toLowerCase();
}

export function isMcpCredentialKey(key: string): boolean {
  const normalized = normalizeMcpKeyName(key);
  return isSensitiveKeyName(normalized)
    || MCP_CREDENTIAL_KEY_NAMES.has(normalized)
    || MCP_CREDENTIAL_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export function parseMcpFlag(argument: string): { readonly name: string; readonly inlineValue?: string } | undefined {
  if (!argument.startsWith('-') || argument === '-' || argument === '--') return undefined;
  if (argument.startsWith('-H') && argument.length > 2 && argument[2] !== '=' && argument[2] !== ':') {
    return { name: '-H', inlineValue: argument.slice(2) };
  }
  if (argument.startsWith('-u') && argument.length > 2 && argument[2] !== '=' && argument[2] !== ':') {
    return { name: '-u', inlineValue: argument.slice(2) };
  }
  if (argument.startsWith('-U') && argument.length > 2 && argument[2] !== '=' && argument[2] !== ':') {
    return { name: '-U', inlineValue: argument.slice(2) };
  }
  const separatorIndex = argument.search(/[=:]/u);
  const name = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
  if (!MCP_FLAG_NAME_PATTERN.test(name)) return undefined;
  return separatorIndex === -1
    ? { name }
    : { name, inlineValue: argument.slice(separatorIndex + 1) };
}

