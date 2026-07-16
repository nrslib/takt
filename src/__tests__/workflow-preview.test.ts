import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getWorkflowDescription } from '../infra/config/loaders/workflowPreview.js';

describe('getWorkflowDescription', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function createProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'takt-workflow-preview-'));
    tempRoots.push(root);
    return root;
  }

  function writeFindingManagerWorkflow(projectDir: string, managerProviderLines: string[]): void {
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(workflowDir, 'finding-manager-preview.yaml'), [
      'name: finding-manager-preview',
      'initial_step: reviewers',
      'max_steps: 2',
      'finding_contract:',
      '  ledger_path: .takt/findings/peer-review.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      ...managerProviderLines.map((line) => `    ${line}`),
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      - name: reviewer-a',
      '        persona: reviewer',
      '        instruction: Review the change.',
      '    rules:',
      '      - when: invalid_manager_output',
      '        next: fix',
      '      - when: done',
      '        next: COMPLETE',
      '  - name: fix',
      '    instruction: Fix manager output issues.',
      '    rules:',
      '      - when: done',
      '        next: COMPLETE',
    ].join('\n'));
  }

  it('finding manager の解決済み provider/model を parallel step summary に含める', () => {
    const projectDir = createProject();
    writeFindingManagerWorkflow(projectDir, ['provider: codex', 'model: gpt-5.5']);

    const description = getWorkflowDescription('finding-manager-preview', projectDir, 1);
    const reviewers = description.stepPreviews[0];
    const manager = reviewers?.substeps?.find((substep) => substep.name === 'findings-manager');

    expect(manager).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      allowedTools: [],
      canEdit: false,
    });
  });

  it('finding manager の provider 直接指定時は persona model を継承しない', () => {
    const projectDir = createProject();
    writeFindingManagerWorkflow(projectDir, ['provider: codex']);
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'persona_providers:',
      '  findings-manager:',
      '    provider: opencode',
      '    model: opencode/persona-model',
    ].join('\n'));

    const description = getWorkflowDescription('finding-manager-preview', projectDir, 1);
    const manager = description.stepPreviews[0]?.substeps
      ?.find((substep) => substep.name === 'findings-manager');

    expect(manager).toMatchObject({
      provider: 'codex',
      allowedTools: [],
      canEdit: false,
    });
    expect(manager?.model).toBeUndefined();
  });
});
