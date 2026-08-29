import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadAllWorkflowsWithSourcesFromDirs } from '../infra/config/loaders/workflowDiscovery.js';
import { assertAllowedPersonaPath } from '../infra/config/loaders/workflowPersonaPathPolicy.js';

describe('workflowDiscovery', () => {
  it('allows shipped personas from either language outside an isolated artifact', () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), 'takt-workflow-discovery-artifact-'));
    try {
      for (const [personaLanguage, contextLanguage] of [['en', 'ja'], ['ja', 'en']] as const) {
        const personaPath = join(process.cwd(), 'builtins', personaLanguage, 'facets', 'personas', 'coder.md');
        expect(() => assertAllowedPersonaPath(personaPath, { lang: contextLanguage })).not.toThrow();
        expect(() => assertAllowedPersonaPath(personaPath, {
          lang: contextLanguage,
          resourceRoot: isolatedRoot,
        })).toThrow('Persona prompt file path is not allowed');
      }
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it('loads every shipped English and Japanese workflow through the normalized rule schema', () => {
    const onWarning = vi.fn();
    const loadLanguageWorkflows = (language: 'en' | 'ja') => loadAllWorkflowsWithSourcesFromDirs(
      process.cwd(),
      [{ dir: join(process.cwd(), 'builtins', language, 'workflows'), source: 'builtin' }],
      { onWarning },
      undefined,
      true,
    );
    const englishWorkflows = loadLanguageWorkflows('en');
    const japaneseWorkflows = loadLanguageWorkflows('ja');

    expect(onWarning).not.toHaveBeenCalled();
    expect([...japaneseWorkflows.keys()].sort()).toEqual([...englishWorkflows.keys()].sort());
    for (const workflows of [englishWorkflows, japaneseWorkflows]) {
      expect(workflows.size).toBeGreaterThan(0);
    }
  });

  it('repo 直下でも builtin の privileged workflow を discovery で skip しない', () => {
    const onWarning = vi.fn();
    const workflows = loadAllWorkflowsWithSourcesFromDirs(
      process.cwd(),
      [{
        dir: join(process.cwd(), 'builtins', 'ja', 'workflows'),
        source: 'builtin',
      }],
      { onWarning },
    );

    expect(onWarning.mock.calls).toEqual([]);
    expect(workflows.has('auto-improvement-loop')).toBe(true);
  });

  it('provider-options ディレクトリ内の YAML を workflow として discovery しない', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-workflow-discovery-'));
    try {
      mkdirSync(join(tempDir, 'provider-options'));
      writeFileSync(join(tempDir, 'provider-options', 'review-readonly.yaml'), [
        'name: review-readonly',
        'steps:',
        '  - name: review',
        '    instruction: "{task}"',
      ].join('\n'));
      writeFileSync(join(tempDir, 'sample.yaml'), [
        'name: sample',
        'steps:',
        '  - name: plan',
        '    instruction: "{task}"',
      ].join('\n'));

      const workflows = loadAllWorkflowsWithSourcesFromDirs(
        process.cwd(),
        [{ dir: tempDir, source: 'project' }],
      );

      expect(workflows.has('sample')).toBe(true);
      expect(workflows.has('provider-options/review-readonly')).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
