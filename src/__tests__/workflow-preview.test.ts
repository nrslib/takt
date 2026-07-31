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

  function writeSingleStepFindingContractWorkflow(projectDir: string, managerProviderLines: string[]): void {
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const outputContractsDir = join(projectDir, '.takt', 'facets', 'output-contracts');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(outputContractsDir, { recursive: true });
    writeFileSync(join(outputContractsDir, 'review-finding-contract.md'), 'Report raw findings as JSON.');
    writeFileSync(join(workflowDir, 'finding-manager-single-step-preview.yaml'), [
      'name: finding-manager-single-step-preview',
      'initial_step: reviewer',
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
      '  - name: reviewer',
      '    persona: reviewer',
      '    instruction: Review the change.',
      '    output_contracts:',
      '      report:',
      '        - name: review.md',
      '          format: review-finding-contract',
      '    rules:',
      '      - condition: invalid_manager_output',
      '        next: fix',
      '      - condition: done',
      '        next: COMPLETE',
      '  - name: fix',
      '    instruction: Fix manager output issues.',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));
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
      '      - condition: invalid_manager_output',
      '        next: fix',
      '      - condition: done',
      '        next: COMPLETE',
      '  - name: fix',
      '    instruction: Fix manager output issues.',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));
  }

  it('dynamic parallel の mode と fixed/pool role を preview に含める', () => {
    const projectDir = createProject();
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'provider: codex',
      'model: gpt-default',
      'takt_providers:',
      '  selector:',
      '    model: gpt-selector',
      '    provider_options:',
      '      codex:',
      '        reasoning_effort: medium',
    ].join('\n'));
    writeFileSync(join(workflowDir, 'dynamic-preview.yaml'), [
      'name: dynamic-preview',
      'initial_step: reviewers',
      'max_steps: 1',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      fixed:',
      '        - name: architecture',
      '          instruction: Review architecture',
      '          rules:',
      '            - condition: approved',
      '      pool:',
      '        - name: frontend',
      '          description: Review frontend',
      '          instruction: Review frontend',
      '          rules:',
      '            - condition: approved',
      '      selection:',
      '        mode: cumulative',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
    ].join('\n'));

    const description = getWorkflowDescription('dynamic-preview', projectDir, 1);

    expect(description.workflowStructure).toContain('selector mode: cumulative');
    expect(description.workflowStructure).toContain('fixed: architecture');
    expect(description.workflowStructure).toContain('pool candidate: frontend');
    expect(description.stepPreviews[0]).toMatchObject({
      name: 'reviewers',
      dynamicSelectionMode: 'cumulative',
      substeps: [
        {
          name: 'dynamic-selector',
          internalAgent: true,
          provider: 'codex',
          model: 'gpt-selector',
          providerSource: 'project',
          permissionMode: 'readonly',
          allowedTools: ['request_user_input', 'update_plan', 'view_image', 'web_search'],
          canEdit: false,
        },
        { name: 'architecture', parallelRole: 'fixed' },
        { name: 'frontend', parallelRole: 'pool' },
      ],
    });

    const overridden = getWorkflowDescription(
      'dynamic-preview',
      projectDir,
      1,
      projectDir,
      {
        provider: 'mock',
        model: 'cli-selector',
        providerSource: 'cli',
        modelSource: 'cli',
      },
    );
    expect(overridden.stepPreviews[0]?.substeps?.[0]).toMatchObject({
      name: 'dynamic-selector',
      provider: 'mock',
      model: 'cli-selector',
      providerSource: 'cli',
      modelSource: 'cli',
    });
    expect(description.stepPreviews[0]?.substeps?.[0]).not.toHaveProperty('providerOptions');
    expect(overridden.stepPreviews[0]?.substeps?.[0]).not.toHaveProperty('providerOptions');
  });

  it('OpenCode selectorをpreview生成前に拒否する', () => {
    const projectDir = createProject();
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'takt_providers:',
      '  selector:',
      '    provider: opencode',
      '    model: opencode/big-pickle',
    ].join('\n'));
    writeFileSync(join(workflowDir, 'unsupported-selector-preview.yaml'), [
      'name: unsupported-selector-preview',
      'initial_step: reviewers',
      'max_steps: 1',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      pool:',
      '        - name: security',
      '          description: Review security',
      '          instruction: Review security',
      '          rules:',
      '            - condition: approved',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
    ].join('\n'));

    expect(() => getWorkflowDescription(
      'unsupported-selector-preview',
      projectDir,
      1,
    )).toThrow('Provider "opencode" does not support strict internal-agent isolation');
  });

  it('AI向けselector previewへ実行用provider optionsを含めない', () => {
    const projectDir = createProject();
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'provider: codex',
      'model: gpt-default',
      'takt_providers:',
      '  selector:',
      '    model: gpt-selector',
      '    provider_options:',
      '      codex:',
      '        base_url: "http://selector-user:selector-password@127.0.0.1:8787?token=selector-token"',
      '        reasoning_effort: medium',
    ].join('\n'));
    writeFileSync(join(workflowDir, 'secret-preview.yaml'), [
      'name: secret-preview',
      'initial_step: reviewers',
      'max_steps: 1',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      pool:',
      '        - name: security',
      '          description: Review security',
      '          instruction: Review security',
      '          rules:',
      '            - condition: approved',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
    ].join('\n'));

    const description = getWorkflowDescription('secret-preview', projectDir, 1);
    const serializedPreview = JSON.stringify(description.stepPreviews);
    const selectorPreview = description.stepPreviews[0]?.substeps?.[0];

    expect(selectorPreview).toMatchObject({
      provider: 'codex',
      model: 'gpt-selector',
      providerSource: 'project',
      permissionMode: 'readonly',
    });
    expect(selectorPreview).not.toHaveProperty('providerOptions');
    expect(serializedPreview).not.toContain('selector-user');
    expect(serializedPreview).not.toContain('selector-password');
    expect(serializedPreview).not.toContain('selector-token');
    expect(serializedPreview).not.toContain('127.0.0.1:8787');
  });

  it('dynamic parallelを含まないworkflowでは未使用の不正selector設定を解決しない', () => {
    const projectDir = createProject();
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'takt_providers:',
      '  selector:',
      '    provider: opencode',
    ].join('\n'));
    writeFileSync(join(workflowDir, 'ordinary-preview.yaml'), [
      'name: ordinary-preview',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    instruction: Implement',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));

    expect(() => getWorkflowDescription('ordinary-preview', projectDir, 1)).not.toThrow();
  });

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

  it('FC サブステップを複数持つ並列親では findings-manager を親に1つだけ含め、サブステップには含めない', () => {
    const projectDir = createProject();
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const outputContractsDir = join(projectDir, '.takt', 'facets', 'output-contracts');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(outputContractsDir, { recursive: true });
    writeFileSync(join(outputContractsDir, 'coding-review-finding-contract.md'), 'Report raw findings as JSON.');
    writeFileSync(join(outputContractsDir, 'security-review-finding-contract.md'), 'Report raw findings as JSON.');
    writeFileSync(join(workflowDir, 'finding-manager-parallel-fc-preview.yaml'), [
      'name: finding-manager-parallel-fc-preview',
      'initial_step: reviewers',
      'max_steps: 2',
      'finding_contract:',
      '  ledger_path: .takt/findings/peer-review.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      '    provider: codex',
      '    model: gpt-5.5',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      - name: coding-review',
      '        persona: reviewer',
      '        instruction: Review the change.',
      '        output_contracts:',
      '          report:',
      '            - name: coding-review.md',
      '              format: coding-review-finding-contract',
      '      - name: security-review',
      '        persona: reviewer',
      '        instruction: Review the change for security issues.',
      '        output_contracts:',
      '          report:',
      '            - name: security-review.md',
      '              format: security-review-finding-contract',
      '    rules:',
      '      - condition: invalid_manager_output',
      '        next: fix',
      '      - condition: done',
      '        next: COMPLETE',
      '  - name: fix',
      '    instruction: Fix manager output issues.',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));

    const description = getWorkflowDescription('finding-manager-parallel-fc-preview', projectDir, 1);
    const reviewers = description.stepPreviews[0];
    const managers = reviewers?.substeps?.filter((substep) => substep.name === 'findings-manager');

    // 実行時（ParallelRunner）は並列ブロック全体につき manager を親レベルで
    // 1回しか起動しないため、preview も親に1つだけ現れるのが正しい。
    expect(managers).toHaveLength(1);
    for (const substep of reviewers?.substeps ?? []) {
      expect(substep.substeps ?? []).toHaveLength(0);
    }
  });

  it('*-finding-contract を持つ team_leader ステップには findings-manager を preview に含めない', () => {
    const projectDir = createProject();
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const outputContractsDir = join(projectDir, '.takt', 'facets', 'output-contracts');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(outputContractsDir, { recursive: true });
    writeFileSync(join(outputContractsDir, 'review-finding-contract.md'), 'Report raw findings as JSON.');
    writeFileSync(join(workflowDir, 'finding-manager-team-leader-preview.yaml'), [
      'name: finding-manager-team-leader-preview',
      'initial_step: implement',
      'max_steps: 2',
      'finding_contract:',
      '  ledger_path: .takt/findings/peer-review.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      '    provider: codex',
      '    model: gpt-5.5',
      'steps:',
      '  - name: implement',
      '    persona: team-leader',
      '    instruction: Decompose and implement the task.',
      '    team_leader:',
      '      persona: team-leader',
      '      max_parts: 2',
      '    output_contracts:',
      '      report:',
      '        - name: review.md',
      '          format: review-finding-contract',
      '    rules:',
      '      - condition: invalid_manager_output',
      '        next: fix',
      '      - condition: done',
      '        next: COMPLETE',
      '  - name: fix',
      '    instruction: Fix manager output issues.',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));

    const description = getWorkflowDescription('finding-manager-team-leader-preview', projectDir, 1);
    const implement = description.stepPreviews[0];

    // 実行時は TeamLeaderRunner へ分岐し StepExecutor.runNormalStep（manager
    // 起動経路）を通らないため、preview にも findings-manager を出さない。
    expect(implement?.name).toBe('implement');
    expect(implement?.substeps ?? []).toHaveLength(0);
  });

  it('*-finding-contract を持つ arpeggio ステップには findings-manager を preview に含めない', () => {
    const projectDir = createProject();
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const outputContractsDir = join(projectDir, '.takt', 'facets', 'output-contracts');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(outputContractsDir, { recursive: true });
    writeFileSync(join(outputContractsDir, 'review-finding-contract.md'), 'Report raw findings as JSON.');
    writeFileSync(join(workflowDir, 'finding-manager-arpeggio-preview.yaml'), [
      'name: finding-manager-arpeggio-preview',
      'initial_step: batch',
      'max_steps: 2',
      'finding_contract:',
      '  ledger_path: .takt/findings/peer-review.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      '    provider: codex',
      '    model: gpt-5.5',
      'steps:',
      '  - name: batch',
      '    persona: worker',
      '    instruction: Process each row.',
      '    arpeggio:',
      '      source: csv',
      '      source_path: ./data.csv',
      '      template: ./prompt.md',
      '    output_contracts:',
      '      report:',
      '        - name: review.md',
      '          format: review-finding-contract',
      '    rules:',
      '      - condition: invalid_manager_output',
      '        next: fix',
      '      - condition: done',
      '        next: COMPLETE',
      '  - name: fix',
      '    instruction: Fix manager output issues.',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));

    const description = getWorkflowDescription('finding-manager-arpeggio-preview', projectDir, 1);
    const batch = description.stepPreviews[0];

    // 実行時は ArpeggioRunner へ分岐し StepExecutor.runNormalStep（manager
    // 起動経路）を通らないため、preview にも findings-manager を出さない。
    expect(batch?.name).toBe('batch');
    expect(batch?.substeps ?? []).toHaveLength(0);
  });

  it('並列親でない単独 FC ステップの後にも findings-manager を preview に含める', () => {
    const projectDir = createProject();
    writeSingleStepFindingContractWorkflow(projectDir, ['provider: codex', 'model: gpt-5.5']);

    const description = getWorkflowDescription('finding-manager-single-step-preview', projectDir, 1);
    const reviewer = description.stepPreviews[0];
    const manager = reviewer?.substeps?.find((substep) => substep.name === 'findings-manager');

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
