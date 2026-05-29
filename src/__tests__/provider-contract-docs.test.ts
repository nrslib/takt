import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { program } from '../app/cli/program.js';
import { ProviderTypeSchema } from '../core/models/schema-base.js';

const providerValues = [
  'claude',
  'claude-sdk',
  'claude-terminal',
  'codex',
  'opencode',
  'cursor',
  'copilot',
  'kiro',
  'mock',
] as const;

const providerPipeList = providerValues.join('|');
const markdownProviderPipeList = providerValues.join('\\|');
const configProviderPipeList = providerValues.join(' | ');

function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf-8');
}

function extractParenthesizedProviderList(content: string, marker: string): string {
  const line = content.split('\n').find((candidate) => candidate.includes(marker));
  if (line === undefined) {
    throw new Error(`Provider marker not found: ${marker}`);
  }

  const match = line.match(/[（(]([^）)]+)[）)]/);
  if (match === null) {
    throw new Error(`Provider list not found for marker: ${marker}`);
  }

  return match[1];
}

function extractConfigProviderList(content: string, marker: string): string {
  const line = content.split('\n').find((candidate) => candidate.includes(marker));
  if (line === undefined) {
    throw new Error(`Provider marker not found: ${marker}`);
  }

  const list = line.split(marker)[1]?.trim();
  if (list === undefined || list.length === 0) {
    throw new Error(`Provider list not found for marker: ${marker}`);
  }

  return list;
}

describe('provider contract documentation', () => {
  it('keeps schema and CLI help provider lists aligned', () => {
    const providerOption = program.options.find((option) => option.long === '--provider');

    expect(Object.values(ProviderTypeSchema.enum)).toEqual([...providerValues]);
    expect(providerOption?.description).toContain(`(${providerPipeList})`);
  });

  it('keeps CLI reference provider lists aligned with the schema', () => {
    expect(
      extractParenthesizedProviderList(readRepositoryFile('docs/cli-reference.md'), 'Override agent provider'),
    ).toBe(markdownProviderPipeList);
    expect(
      extractParenthesizedProviderList(readRepositoryFile('docs/cli-reference.ja.md'), 'エージェント provider を上書き'),
    ).toBe(markdownProviderPipeList);
    expect(
      extractParenthesizedProviderList(readRepositoryFile('docs/ci-cd.md'), 'Override agent provider'),
    ).toBe(markdownProviderPipeList);
    expect(
      extractParenthesizedProviderList(readRepositoryFile('docs/ci-cd.ja.md'), 'エージェント provider を上書き'),
    ).toBe(markdownProviderPipeList);
  });

  it('keeps builtin config provider lists aligned with the schema', () => {
    expect(
      extractConfigProviderList(readRepositoryFile('builtins/en/config.yaml'), 'Default provider:'),
    ).toBe(configProviderPipeList);
    expect(
      extractConfigProviderList(readRepositoryFile('builtins/ja/config.yaml'), 'デフォルトプロバイダー:'),
    ).toBe(configProviderPipeList);
  });
});
