/**
 * UI label loader utility
 *
 * Loads user-facing display strings from language-specific YAML files
 * (labels_en.yaml / labels_ja.yaml) and provides
 * key-based access with template variable substitution.
 *
 * This module handles UI labels only — AI prompts live in ../prompts/.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Language } from '../../core/models/types.js';
import { DEFAULT_LANGUAGE } from '../constants.js';

/** Cached YAML data per language */
const labelCache = new Map<Language, Record<string, unknown>>(await Promise.all(
  (['ja', 'en'] as const).map(async (lang) => {
    const path = join(dirname(fileURLToPath(import.meta.url)), `labels_${lang}.yaml`);
    return [lang, parseYaml(await readFile(path, 'utf8')) as Record<string, unknown>] as const;
  }),
));

function loadLabels(lang: Language): Record<string, unknown> {
  const cached = labelCache.get(lang);
  if (cached) return cached;
  throw new Error(`Unsupported label language: ${lang}`);
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
 * Get a UI label string from the language-specific YAML by dot-separated key.
 *
 * When `lang` is provided, loads the corresponding language file.
 * When `lang` is omitted, uses DEFAULT_LANGUAGE.
 *
 * Template variables in `{name}` format are replaced when `vars` is given.
 */
export function getLabel(
  key: string,
  lang?: Language,
  vars?: Record<string, string>,
): string {
  const effectiveLang = lang ?? DEFAULT_LANGUAGE;
  const data = loadLabels(effectiveLang);

  const value = resolveKey(data, key);
  if (typeof value !== 'string') {
    throw new Error(`Label key not found: ${key}${lang ? ` (lang: ${lang})` : ''}`);
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
 * Useful for structured label groups (e.g. UI text objects).
 */
export function getLabelObject<T>(key: string, lang?: Language): T {
  const effectiveLang = lang ?? DEFAULT_LANGUAGE;
  const data = loadLabels(effectiveLang);

  const value = resolveKey(data, key);
  if (value === undefined || value === null) {
    throw new Error(`Label key not found: ${key}${lang ? ` (lang: ${lang})` : ''}`);
  }

  return value as T;
}
