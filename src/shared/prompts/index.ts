/**
 * Markdown template loader
 *
 * Loads prompt strings from Markdown template files (.md),
 * applies {{variable}} substitution and {{#if}}...{{else}}...{{/if}}
 * conditional blocks.
 *
 * Templates are organized in language subdirectories:
 *   {lang}/{name}.md  — localized templates
 *
 * Template engine functions (processConditionals, substituteVariables,
 * renderTemplate) are delegated to faceted-prompting.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from '../../core/models/types.js';
import { renderTemplate } from '../../faceted-prompting/index.js';

export { renderTemplate } from '../../faceted-prompting/index.js';

/** Cached raw template text (before variable substitution) */
const templateCache = new Map<string, string>();

/**
 * Resolve template file path.
 *
 * Loads `{lang}/{name}.md`.
 * Throws if the file does not exist.
 */
function resolveTemplatePath(name: string, lang: Language): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  const localizedPath = join(__dirname, lang, `${name}.md`);
  if (existsSync(localizedPath)) {
    return localizedPath;
  }

  throw new Error(
    `Template not found: ${name} (lang: ${lang})`,
  );
}

/**
 * Strip HTML meta comments (<!-- ... -->) from template content.
 */
function stripMetaComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Read raw template text with caching.
 */
function readTemplate(filePath: string): string {
  const cached = templateCache.get(filePath);
  if (cached !== undefined) return cached;

  const raw = readFileSync(filePath, 'utf-8');
  const content = stripMetaComments(raw);
  templateCache.set(filePath, content);
  return content;
}

/**
 * Load a Markdown template, apply variable substitution and conditional blocks.
 *
 * @param name  Template name (without extension), e.g. 'score_interactive_system_prompt'
 * @param lang  Language ('en' | 'ja').
 * @param vars  Variable values to substitute
 * @returns Final prompt string
 */
export function loadTemplate(
  name: string,
  lang: Language,
  vars?: Record<string, string | boolean>,
): string {
  const filePath = resolveTemplatePath(name, lang);
  const raw = readTemplate(filePath);

  if (vars) {
    return renderTemplate(raw, vars);
  }
  return raw;
}

/** Reset cache (for tests) */
export function _resetCache(): void {
  templateCache.clear();
}
