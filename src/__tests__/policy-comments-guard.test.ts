import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('policy-comments (review guard)', () => {
  it('session-key tests do not start with a block explainer comment', () => {
    const path = join(here, 'session-key.test.ts');
    const raw = readFileSync(path, 'utf-8');
    expect(raw.trimStart().startsWith('/**')).toBe(false);
  });

  it('stream-json-lines omits restored stream-line explainer JSDoc', () => {
    const path = join(here, '../infra/claude-headless/stream-json-lines.ts');
    const raw = readFileSync(path, 'utf-8');
    expect(raw).not.toContain('Parse one line of stream-json stdout');
  });

  it('headless types omit claudeCliPath explainer JSDoc line', () => {
    const path = join(here, '../infra/claude-headless/types.ts');
    const raw = readFileSync(path, 'utf-8');
    expect(raw).not.toMatch(/\*\* Executable path;/);
  });

  it('workflow-types omits restored explainer JSDoc phrases', () => {
    const path = join(here, '../core/models/workflow-types.ts');
    const raw = readFileSync(path, 'utf-8');
    expect(raw).not.toContain('Output contract item configuration');
    expect(raw).not.toContain('Workflow-level default provider options');
    expect(raw).not.toContain('Loop monitor configuration for detecting');
  });

  it('claude split test files do not start with block JSDoc', () => {
    for (const name of [
      'claude-provider-split-schema.test.ts',
      'claude-provider-split-block-options.test.ts',
      'claude-provider-split-model-compatibility.test.ts',
    ]) {
      const path = join(here, name);
      const raw = readFileSync(path, 'utf-8');
      expect(raw.trimStart().startsWith('/**')).toBe(false);
    }
  });

  it('registry split test avoids redundant ProviderType cast on claude-sdk / claude', () => {
    const path = join(here, 'claude-provider-split-registry.test.ts');
    const raw = readFileSync(path, 'utf-8');
    expect(raw).not.toMatch(/'claude-sdk'\s+as\s+ProviderType/);
    expect(raw).not.toMatch(/'claude'\s+as\s+ProviderType/);
  });

  it('providers index omits stale single-claude module explainer (doc-accuracy)', () => {
    const path = join(here, '../infra/providers/index.ts');
    const raw = readFileSync(path, 'utf-8');
    expect(raw).not.toMatch(
      /Provides a unified interface for different agent providers \(Claude, Codex, OpenCode, Cursor, Mock\)/,
    );
  });

  it('split-touched sources omit leading block JSDoc (policy-comments)', () => {
    for (const rel of [
      'builtin-workflow-resources.test.ts',
      '../shared/types/provider.ts',
      '../infra/providers/claude-headless.ts',
      '../core/workflow/permission-profile-resolution.ts',
      '../infra/claude/options-builder.ts',
    ]) {
      const path = join(here, rel);
      const raw = readFileSync(path, 'utf-8');
      expect(raw.trimStart().startsWith('/**'), `${rel} must not start with block JSDoc`).toBe(false);
    }
  });

  it('claude-sdk provider split files omit block JSDoc (policy-comments)', () => {
    for (const rel of [
      '../infra/providers/claude.ts',
      '../infra/providers/types.ts',
      '../infra/providers/index.ts',
    ]) {
      const path = join(here, rel);
      const raw = readFileSync(path, 'utf-8');
      expect(raw).not.toContain('/**', `${rel} must not contain block JSDoc`);
    }
  });
});
