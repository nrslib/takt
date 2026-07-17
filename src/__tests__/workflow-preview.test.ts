import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getWorkflowDescription } from '../infra/config/loaders/workflowPreview.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolveConfigValue.js';

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

  function writeAutoRoutingProject(projectDir: string, ruleLines: string[]): void {
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'auto_routing:',
      '  strategy: balanced',
      '  router:',
      '    provider: claude-sdk',
      '    model: claude-haiku-4-5-20251001',
      '  candidates:',
      '    - name: coding',
      '      description: Coding candidate',
      '      provider: opencode',
      '      model: opencode/big-pickle',
      '      cost_tier: medium',
      '      provider_options:',
      '        opencode:',
      '          allowed_tools:',
      '            - read',
      ...ruleLines,
    ].join('\n'));
    writeFileSync(join(workflowDir, 'auto-preview.yaml'), [
      'name: auto-preview',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    persona: coder',
      '    instruction: Implement the task.',
      '    edit: false',
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

  it.each([
    {
      label: 'provider のみ',
      workflowProvider: 'codex',
      workflowModel: 'gpt-5.5',
      envProvider: 'mock',
      envModel: undefined,
      expectedProvider: 'mock',
      expectedModel: 'gpt-5.5',
    },
    {
      label: 'model のみ',
      workflowProvider: 'mock',
      workflowModel: 'configured-model',
      envProvider: undefined,
      envModel: 'mock/env-model',
      expectedProvider: 'mock',
      expectedModel: 'mock/env-model',
    },
    {
      label: 'provider/model',
      workflowProvider: 'codex',
      workflowModel: 'gpt-5.5',
      envProvider: 'mock',
      envModel: 'mock/env-model',
      expectedProvider: 'mock',
      expectedModel: 'mock/env-model',
    },
  ])('環境変数由来の $label を finding manager の直接指定より優先する', ({
    workflowProvider,
    workflowModel,
    envProvider,
    envModel,
    expectedProvider,
    expectedModel,
  }) => {
    const projectDir = createProject();
    writeFindingManagerWorkflow(projectDir, [
      `provider: ${workflowProvider}`,
      `model: ${workflowModel}`,
    ]);
    const previousProvider = process.env['TAKT_PROVIDER'];
    const previousModel = process.env['TAKT_MODEL'];
    if (envProvider === undefined) delete process.env['TAKT_PROVIDER'];
    else process.env['TAKT_PROVIDER'] = envProvider;
    if (envModel === undefined) delete process.env['TAKT_MODEL'];
    else process.env['TAKT_MODEL'] = envModel;
    invalidateAllResolvedConfigCache();

    try {
      const description = getWorkflowDescription('finding-manager-preview', projectDir, 1);
      const manager = description.stepPreviews[0]?.substeps?.find(
        (substep) => substep.name === 'findings-manager',
      );

      expect(manager).toMatchObject({
        provider: expectedProvider,
        model: expectedModel,
      });
    } finally {
      if (previousProvider === undefined) delete process.env['TAKT_PROVIDER'];
      else process.env['TAKT_PROVIDER'] = previousProvider;
      if (previousModel === undefined) delete process.env['TAKT_MODEL'];
      else process.env['TAKT_MODEL'] = previousModel;
      invalidateAllResolvedConfigCache();
    }
  });

  it('workflow_config の provider/model を project config より優先する', () => {
    const projectDir = createProject();
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'provider: opencode',
      'model: opencode/project-model',
    ].join('\n'));
    writeFileSync(join(workflowDir, 'workflow-priority.yaml'), [
      'name: workflow-priority',
      'workflow_config:',
      '  provider: codex',
      '  model: gpt-5',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    instruction: Implement the task.',
      '    rules:',
      '      - when: done',
      '        next: COMPLETE',
    ].join('\n'));
    invalidateAllResolvedConfigCache();

    const preview = getWorkflowDescription('workflow-priority', projectDir, 1).stepPreviews[0];

    expect(preview).toMatchObject({ provider: 'codex', model: 'gpt-5' });
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

  it('静的 auto_routing rule の provider/model/tools を step summary に反映する', () => {
    const projectDir = createProject();
    writeAutoRoutingProject(projectDir, [
      '  rules:',
      '    steps:',
      '      implement: coding',
    ]);

    const preview = getWorkflowDescription('auto-preview', projectDir, 1).stepPreviews[0];

    expect(preview).toMatchObject({
      provider: 'opencode',
      model: 'opencode/big-pickle',
      allowedTools: ['read'],
    });
  });

  it('動的 auto_routing 判定が必要な step は provider/model/tools を未解決に保つ', () => {
    const projectDir = createProject();
    writeAutoRoutingProject(projectDir, []);

    const preview = getWorkflowDescription('auto-preview', projectDir, 1).stepPreviews[0];

    expect(preview?.provider).toBeUndefined();
    expect(preview?.model).toBeUndefined();
    expect(preview?.allowedTools).toEqual([]);
  });
});
