import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { loadAllWorkflowsWithSourcesFromDirs } from '../infra/config/loaders/workflowDiscovery.js';

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
    expect(englishWorkflows.size).toBe(japaneseWorkflows.size);
    for (const workflows of [englishWorkflows, japaneseWorkflows]) {
      expect(workflows.size).toBeGreaterThan(0);
      expect(workflows.has('peer-review-suite-base')).toBe(true);
      expect(workflows.has('peer-review-suite-frontend')).toBe(true);
      expect(workflows.has('peer-review-suite-cqrs')).toBe(true);
      expect(workflows.has('peer-review-suite-frontend-cqrs')).toBe(true);
    }
  });

  it.each(['en', 'ja'] as const)('keeps the composed shared fix step report non-judging in %s', (language) => {
    const source = readFileSync(
      join(process.cwd(), 'builtins', language, 'steps', 'peer-review-fix.yaml'),
      'utf-8',
    );
    const step = parseYaml(source) as {
      output_contracts?: { report?: Array<Record<string, unknown>> };
    };

    expect(step.output_contracts?.report).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'fix-report.md',
        format: 'fix-report',
        use_judge: false,
      }),
    ]));
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
