import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTemplate } from '../shared/prompts/index.js';
import type { Language } from '../core/models/types.js';

/**
 * テンプレートエンジン（faceted-prompting）が解釈できるのは `{{#if}}` /
 * `{{else}}` / `{{/if}}` と `{{var}}` だけで、`{{#unless}}` のような構文は
 * **黙ってリテラルのまま出力される**。実際に `{{#unless restatementOnly}}` が
 * Finding Contract のプロンプト全件へ漏れていた。
 *
 * 全テンプレート × 代表的な変数集合（全 truthy / 全 falsy）で描画し、`{{` が
 * 1つでも残ったら失敗させる。未対応構文とタイポの両方をここで止める。
 */

const PROMPTS_ROOT = join(process.cwd(), 'src', 'shared', 'prompts');
const LANGUAGES: readonly Language[] = ['en', 'ja'];

function collectTemplateNames(langRoot: string, prefix = ''): string[] {
  return readdirSync(langRoot).flatMap((entry) => {
    const absolute = join(langRoot, entry);
    if (statSync(absolute).isDirectory()) {
      return collectTemplateNames(absolute, `${prefix}${entry}/`);
    }
    return entry.endsWith('.md') ? [`${prefix}${entry.slice(0, -'.md'.length)}`] : [];
  });
}

function stripMetaComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

function collectVariableNames(langRoot: string, name: string): string[] {
  const body = stripMetaComments(readFileSync(join(langRoot, `${name}.md`), 'utf-8'));
  const names = new Set<string>();
  for (const match of body.matchAll(/\{\{#if\s+(\w+)\}\}/g)) {
    names.add(match[1]!);
  }
  for (const match of body.matchAll(/\{\{(\w+)\}\}/g)) {
    names.add(match[1]!);
  }
  names.delete('else');
  return [...names];
}

describe('prompt templates', () => {
  const cases = LANGUAGES.flatMap((language) => {
    const langRoot = join(PROMPTS_ROOT, language);
    return collectTemplateNames(langRoot).map((name) => ({ language, langRoot, name }));
  });

  it('covers every bundled template', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map(({ language, langRoot, name }) => [`${language}/${name}`, language, langRoot, name]))(
    '%s renders without leaving template syntax behind',
    (label, language, langRoot, name) => {
      const variableNames = collectVariableNames(langRoot as string, name as string);
      const truthyVars = Object.fromEntries(variableNames.map((key) => [key, 'x']));
      const falsyVars = Object.fromEntries(variableNames.map((key) => [key, false]));

      for (const vars of [truthyVars, falsyVars]) {
        const rendered = loadTemplate(name as string, language as Language, vars);
        expect(rendered, `${label} left unrendered template syntax`).not.toContain('{{');
      }
    },
  );
});
