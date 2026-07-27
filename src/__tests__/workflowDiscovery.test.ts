import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import {
  loadAllWorkflowsWithSourcesFromDirs,
} from '../infra/config/loaders/workflowDiscovery.js';

describe('workflowDiscovery', () => {
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
    expect(englishWorkflows.size + japaneseWorkflows.size).toBe(108);
  });

  it.each(['en', 'ja'] as const)('gives every shared fix step a non-judging fix report in %s workflows', (language) => {
    const rootDir = process.cwd();
    const fixInstructions = new Set(['en', 'ja'].map((facetLanguage) => readFileSync(
      join(rootDir, 'builtins', facetLanguage, 'facets', 'instructions', 'fix.md'),
      'utf-8',
    )));
    const workflows = loadAllWorkflowsWithSourcesFromDirs<WorkflowConfig>(
      rootDir,
      [{ dir: join(rootDir, 'builtins', language, 'workflows'), source: 'builtin' }],
      undefined,
      undefined,
      true,
    );
    const sharedFixSteps = Array.from(workflows.values())
      .flatMap(({ config }) => config.steps)
      .filter((step) => fixInstructions.has(step.instruction));

    expect(sharedFixSteps.length).toBeGreaterThan(0);
    for (const step of sharedFixSteps) {
      expect(step.outputContracts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'fix-report.md',
          formatRef: 'fix-report',
          useJudge: false,
        }),
      ]));
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
