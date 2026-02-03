/**
 * Prompt loader utility
 *
 * Loads prompt strings from language-specific YAML files
 * (prompts_en.yaml / prompts_ja.yaml) and provides
 * key-based access with template variable substitution.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Language } from '../../core/models/types.js';
import { DEFAULT_LANGUAGE } from '../constants.js';

/** Cached YAML data per language */
const promptCache = new Map<Language, Record<string, unknown>>();

function loadPrompts(lang: Language): Record<string, unknown> {
  const cached = promptCache.get(lang);
  if (cached) return cached;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const yamlPath = join(__dirname, `prompts_${lang}.yaml`);
  const content = readFileSync(yamlPath, 'utf-8');
  const data = parseYaml(content) as Record<string, unknown>;
  promptCache.set(lang, data);
  return data;
}

/**
 * Resolve a dot-separated key path to a value in a nested object.
 * Returns undefined if the path does not exist.
 */
function resolveKey(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Replace {key} placeholders in a template string with values from vars.
 * Unmatched placeholders are left as-is.
 */
function applyVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (key in vars) {
      const value: string = vars[key] as string;
      return value;
    }
    return match;
  });
}

/**
 * Get a prompt string from the language-specific YAML by dot-separated key.
 *
 * When `lang` is provided, loads the corresponding language file.
 * When `lang` is omitted, uses DEFAULT_LANGUAGE.
 *
 * Template variables in `{name}` format are replaced when `vars` is given.
 */
export function getPrompt(
  key: string,
  lang?: Language,
  vars?: Record<string, string>,
): string {
  const effectiveLang = lang ?? DEFAULT_LANGUAGE;
  const data = loadPrompts(effectiveLang);

  const value = resolveKey(data, key);
  if (typeof value !== 'string') {
    throw new Error(`Prompt key not found: ${key}${lang ? ` (lang: ${lang})` : ''}`);
  }

  if (vars) {
    return applyVars(value, vars);
  }
  return value;
}

/**
 * Get a nested object from the language-specific YAML by dot-separated key.
 *
 * When `lang` is provided, loads the corresponding language file.
 * When `lang` is omitted, uses DEFAULT_LANGUAGE.
 *
 * Useful for structured prompt groups (e.g. UI text objects, metadata strings).
 */
export function getPromptObject<T>(key: string, lang?: Language): T {
  const effectiveLang = lang ?? DEFAULT_LANGUAGE;
  const data = loadPrompts(effectiveLang);

  const value = resolveKey(data, key);
  if (value === undefined || value === null) {
    throw new Error(`Prompt key not found: ${key}${lang ? ` (lang: ${lang})` : ''}`);
  }

  return value as T;
}

/** Reset cached data (for testing) */
export function _resetCache(): void {
  promptCache.clear();
}
