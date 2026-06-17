import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { GlobalConfigSchema } from '../core/models/index.js';

const languages = ['en', 'ja'] as const;

const sampleTopLevelKeys = new Set([
  'language',
  'provider',
  'model',
  'worktree_dir',
  'prevent_sleep',
  'auto_fetch',
  'base_branch',
  'concurrency',
  'task_poll_interval_ms',
  'sync_project_local_takt_on_retry',
  'auto_pr',
  'draft_pr',
  'branch_name_strategy',
  'pipeline',
  'minimal_output',
  'notification_sound',
  'notification_sound_events',
  'logging',
  'observability',
  'analytics',
  'interactive_preview_steps',
  'persona_providers',
  'provider_options',
  'provider_profiles',
  'runtime',
  'workflow_runtime_prepare',
  'workflow_command_gates',
  'workflow_mcp_servers',
  'workflow_arpeggio',
  'rate_limit_fallback',
  'sync_conflict_resolver',
  'workflow_overrides',
  'anthropic_api_key',
  'openai_api_key',
  'gemini_api_key',
  'google_api_key',
  'groq_api_key',
  'openrouter_api_key',
  'opencode_api_key',
  'cursor_api_key',
  'kiro_api_key',
  'codex_cli_path',
  'claude_cli_path',
  'cursor_cli_path',
  'copilot_cli_path',
  'kiro_cli_path',
  'copilot_github_token',
  'bookmarks_file',
  'enable_builtin_workflows',
  'disabled_builtins',
  'workflow_categories_file',
]);

function readRepoFile(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), 'utf-8');
}

function readBuiltinConfig(lang: 'en' | 'ja', fileName: string): string {
  return readRepoFile('builtins', lang, fileName);
}

function uncommentSampleConfig(content: string): string {
  const uncommentedLines: string[] = [];
  let inConfigBlock = false;

  for (const line of content.split('\n')) {
    const match = /^#(?<body>\s*.*)$/.exec(line);
    if (!match?.groups) {
      inConfigBlock = false;
      continue;
    }

    const body = match.groups.body;
    const topLevelMatch = /^ (?<key>[A-Za-z_][A-Za-z0-9_]*):/.exec(body);
    if (topLevelMatch?.groups) {
      inConfigBlock = sampleTopLevelKeys.has(topLevelMatch.groups.key);
      if (inConfigBlock) {
        uncommentedLines.push(body);
      }
      continue;
    }

    if (inConfigBlock && /^ {3,}(?:[A-Za-z_][A-Za-z0-9_]*:|-\s+.*)/.test(body)) {
      uncommentedLines.push(body);
    }
  }

  return uncommentedLines.join('\n');
}

function parseYamlObject(content: string): Record<string, unknown> {
  const parsed = parseYaml(content);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('YAML content must parse to an object');
  }
  return parsed as Record<string, unknown>;
}

function collectKeyPaths(value: unknown, prefix: string[] = []): string[] {
  if (Array.isArray(value)) {
    const paths = [`${prefix.join('.')}[]`];
    for (const item of value) {
      paths.push(...collectKeyPaths(item, [...prefix, '[]']));
    }
    return paths;
  }

  if (value === null || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const nextPrefix = [...prefix, key];
    return [nextPrefix.join('.'), ...collectKeyPaths(child, nextPrefix)];
  });
}

describe('builtin config sample templates', () => {
  it('should keep ja and en commented sample key structures aligned', () => {
    const [enPaths, jaPaths] = languages.map((lang) => {
      const activeSample = uncommentSampleConfig(readBuiltinConfig(lang, 'config.sample.yaml'));
      return collectKeyPaths(parseYamlObject(activeSample)).sort();
    });

    expect(jaPaths).toEqual(enPaths);
  });

  it('should keep builtin config templates minimal with only language active', () => {
    for (const lang of languages) {
      const parsed = parseYamlObject(readBuiltinConfig(lang, 'config.yaml'));
      expect(parsed).toEqual({ language: lang });
    }
  });

  it('should keep uncommented sample examples valid for GlobalConfigSchema', () => {
    for (const lang of languages) {
      const activeSample = uncommentSampleConfig(readBuiltinConfig(lang, 'config.sample.yaml'));
      const parsed = parseYamlObject(activeSample);
      const result = GlobalConfigSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(result.error.message);
      }
      expect(result.success).toBe(true);
    }
  });
});
