import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import type { WorkflowConfig } from '../core/models/index.js';
import type { ProviderResolutionSource } from '../core/workflow/provider-options-trace.js';
import {
  getProviderValidationErrorSource,
  withProviderValidationErrorSource,
} from '../core/workflow/provider-validation-error.js';
import { withWorkflowConfigErrorPath } from '../core/workflow/workflow-config-error.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';
import {
  registerWorkflowStepFragmentErrorContext,
  translateWorkflowStepFragmentError,
} from '../infra/config/loaders/workflowStepFragmentErrorTranslator.js';
import { captureConfigErrorMessage as configErrorMessage } from './helpers/step-fragment-test-helpers.js';

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function errorMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected action to throw');
}

function engineValidationError(workflowPath: string, projectDir: string): string {
  const workflow = loadWorkflowFromFile(workflowPath, projectDir);
  return errorMessage(() => new WorkflowEngine(workflow, projectDir, 'test task', { projectCwd: projectDir }));
}

function configEngineError(workflowPath: string, projectDir: string): string {
  return configErrorMessage(() => new WorkflowEngine(
    loadWorkflowFromFile(workflowPath, projectDir),
    projectDir,
    'test task',
    { projectCwd: projectDir },
  ));
}

function standardWorkflowYaml(uses: string): string {
  return [
    'name: default',
    'initial_step: review',
    'max_steps: 1',
    'steps:',
    '  - name: review',
    `    uses: ${uses}`,
    '    rules:',
    '      - condition: done',
    '        next: COMPLETE',
    '',
  ].join('\n');
}

describe('workflow step fragment provenance', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    projectDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-provenance-project-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-provenance-global-'));
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('should attribute a normalizer error to the outer fragment that overrides the field', () => {
    writeFile(projectDir, '.takt/steps/inner.yaml', [
      'persona: reviewer',
      'instruction: review',
      '',
    ].join('\n'));
    const outerPath = writeFile(projectDir, '.takt/steps/outer.yaml', [
      'uses: inner',
      'persona: ""',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/nested.yaml', [
      'name: nested',
      'initial_step: outer',
      'steps:',
      '  - name: review',
      '    uses: outer',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('empty persona value');
    expect(message).toContain('step fragment "outer"');
    expect(message).toContain(outerPath);
  });

  it('should attribute a provider option resolution error to the outer fragment that overrides the field', () => {
    writeFile(projectDir, '.takt/steps/inner.yaml', [
      'instruction: review',
      'provider_options:',
      '  extends: inherited-options',
      '',
    ].join('\n'));
    const outerPath = writeFile(projectDir, '.takt/steps/outer.yaml', [
      'uses: inner',
      'provider_options:',
      '  extends: missing-options',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/nested-provider-options.yaml', [
      'name: nested-provider-options',
      'initial_step: outer',
      'steps:',
      '  - name: review',
      '    uses: outer',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('provider_options.extends not found: missing-options');
    expect(message).toContain('step fragment "outer"');
    expect(message).toContain(outerPath);
  });

  it('should attribute a Finding Contract format validation error to its fragment format field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'output_contracts:',
      '  report:',
      '    - name: review.md',
      '      format: review-finding-contract',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/finding-contract-format.yaml', [
      'name: finding-contract-format',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain('has no finding_contract');
    expect(message).toContain('from step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('should attribute a team leader Finding Contract mode error to its fragment mode field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/fix.yaml', [
      'instruction: fix',
      'team_leader:',
      '  mode: finding_contract_fix',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/team-leader-mode.yaml', [
      'name: team-leader-mode',
      'initial_step: fix',
      'steps:',
      '  - name: fix',
      '    uses: fix',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain('team_leader.mode "finding_contract_fix"');
    expect(message).toContain('step fragment "fix"');
    expect(message).toContain(fragmentPath);
  });

  it('should attribute a Finding Contract structured output error to its fragment field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'structured_output:',
      '  schema_ref: decision',
      'output_contracts:',
      '  report:',
      '    - name: review.md',
      '      format: review-finding-contract',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/schemas/decision.json', '{"type":"object"}\n');
    const workflowPath = writeFile(projectDir, '.takt/workflows/structured-output.yaml', [
      'name: structured-output',
      'initial_step: review',
      'finding_contract:',
      '  ledger_path: .takt/findings/ledger.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain('cannot combine finding_contract raw findings with structured_output');
    expect(message).toContain('from step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('retains fragment context for a caller structured output override', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'output_contracts:',
      '  report:',
      '    - name: review.md',
      '      format: review-finding-contract',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/schemas/decision.json', '{"type":"object"}\n');
    const workflowPath = writeFile(projectDir, '.takt/workflows/caller-structured-output.yaml', [
      'name: caller-structured-output',
      'initial_step: review',
      'finding_contract:',
      '  ledger_path: .takt/findings/ledger.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '    structured_output:',
      '      schema_ref: decision',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain('cannot combine finding_contract raw findings with structured_output');
    expect(message).toContain('step uses fragment "review"');
    expect(message).not.toContain('from step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('retains fragment context when a workflow_call resolver is unavailable', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/without-resolver.yaml', [
      'name: without-resolver',
      'initial_step: delegate',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain('workflowCallResolver is required');
    expect(message).toContain('step fragment "delegate"');
    expect(message).toContain(fragmentPath);
  });

  it('should attribute a parallel structured output error to the sub-step fragment field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/reviewer.yaml', [
      'instruction: review',
      'structured_output:',
      '  schema_ref: decision',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/schemas/decision.json', '{"type":"object"}\n');
    const workflowPath = writeFile(projectDir, '.takt/workflows/parallel-structured-output.yaml', [
      'name: parallel-structured-output',
      'initial_step: review',
      'finding_contract:',
      '  ledger_path: .takt/findings/ledger.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    parallel:',
      '      - name: nested-review',
      '        uses: reviewer',
      '        rules:',
      '          - condition: done',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('Invalid input');
    // Zod issues are serialized as JSON here, so embedded quotes are escaped.
    expect(message).toContain('step fragment \\"reviewer\\"');
    expect(message).toContain(fragmentPath);
  });

  it('attributes an array-root schema error to the fragment that provides the array', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'policy:',
      '  - 42',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/array-root.yaml', [
      'name: array-root',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('step fragment \\"review\\"');
    expect(message).toContain(fragmentPath);
    expect(message).not.toContain('invalid field is defined by the workflow');
  });

  it('does not attribute a caller parallel structured output override to a fragment', () => {
    writeFile(projectDir, '.takt/steps/reviewer.yaml', [
      'instruction: review',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/schemas/decision.json', '{"type":"object"}\n');
    const workflowPath = writeFile(projectDir, '.takt/workflows/caller-parallel-structured-output.yaml', [
      'name: caller-parallel-structured-output',
      'initial_step: review',
      'finding_contract:',
      '  ledger_path: .takt/findings/ledger.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    parallel:',
      '      - name: nested-review',
      '        uses: reviewer',
      '        rules:',
      '          - condition: done',
      '        structured_output:',
      '          schema_ref: decision',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('Invalid input');
    expect(message).not.toContain('step fragment "reviewer"');
    expect(message).not.toContain('step fragment \\"reviewer\\"');
  });

  it('should attribute a delegated Finding Contract intake error to its fragment delegation field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'team_leader:',
      '  max_parts: 1',
      'output_contracts:',
      '  report:',
      '    - name: review.md',
      '      format: review-finding-contract',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/delegated-intake.yaml', [
      'name: delegated-intake',
      'initial_step: review',
      'finding_contract:',
      '  ledger_path: .takt/findings/ledger.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain('finding_contract intake is unavailable');
    expect(message).toContain('from step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('retains fragment context for a caller delegated intake override', () => {
    writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'output_contracts:',
      '  report:',
      '    - name: review.md',
      '      format: review-finding-contract',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/caller-delegated-intake.yaml', [
      'name: caller-delegated-intake',
      'initial_step: review',
      'finding_contract:',
      '  ledger_path: .takt/findings/ledger.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '    team_leader:',
      '      max_parts: 1',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain('finding_contract intake is unavailable');
    expect(message).toContain('step uses fragment "review"');
    expect(message).not.toContain('from step fragment "review"');
  });

  it('should attribute an arpeggio Finding Contract intake error to its fragment delegation field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'arpeggio:',
      '  source: csv',
      '  source_path: input.csv',
      '  template: prompt.md',
      'output_contracts:',
      '  report:',
      '    - name: review.md',
      '      format: review-finding-contract',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/arpeggio-intake.yaml', [
      'name: arpeggio-intake',
      'initial_step: review',
      'finding_contract:',
      '  ledger_path: .takt/findings/ledger.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain('finding_contract intake is unavailable');
    expect(message).toContain('from step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('retains fragment context for a caller arpeggio override', () => {
    writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'output_contracts:',
      '  report:',
      '    - name: review.md',
      '      format: review-finding-contract',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/caller-arpeggio-intake.yaml', [
      'name: caller-arpeggio-intake',
      'initial_step: review',
      'finding_contract:',
      '  ledger_path: .takt/findings/ledger.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '    arpeggio:',
      '      source: csv',
      '      source_path: input.csv',
      '      template: prompt.md',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain('finding_contract intake is unavailable');
    expect(message).toContain('step uses fragment "review"');
    expect(message).not.toContain('from step fragment "review"');
  });

  it('should attribute a promotion provider validation error to the fragment that provides it', () => {
    writeFile(projectDir, '.takt/steps/inner.yaml', [
      'instruction: review',
      '',
    ].join('\n'));
    const outerPath = writeFile(projectDir, '.takt/steps/outer.yaml', [
      'uses: inner',
      'promotion:',
      '  - at: 1',
      '    provider:',
      '      type: opencode',
      '      model: invalid-model',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/promotion-provider.yaml', [
      'name: promotion-provider',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    uses: outer',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain("promotion[0].model must be in 'provider/model' format");
    expect(message).toContain('step fragment "outer"');
    expect(message).toContain(outerPath);
    expect(message).not.toContain('step fragment "inner"');
  });

  it('should attribute a nested provider model validation error to its fragment model field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'provider:',
      '  type: opencode',
      '  model: invalid-model',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/nested-provider-model.yaml', [
      'name: nested-provider-model',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain("step \"review\".model must be in 'provider/model' format");
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it.each([
    ['normal step', 'review', '  - name: review\n    uses: review\n    rules:\n      - condition: done\n        next: COMPLETE'],
    ['parallel sub-step', 'reviewers', '  - name: reviewers\n    parallel:\n      - name: review\n        uses: review\n        rules:\n          - condition: done\n    rules:\n      - condition: all("done")\n        next: COMPLETE'],
  ])('attributes a model-less OpenCode provider from a fragment in a %s to its provider field', (_placement, initialStep, steps) => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'provider: opencode',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/opencode-provider.yaml', [
      'name: opencode-provider',
      `initial_step: ${initialStep}`,
      'steps:',
      steps,
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain("provider 'opencode' requires model");
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('should attribute a parallel nested provider model validation error to its fragment model field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/reviewer.yaml', [
      'instruction: review',
      'provider:',
      '  type: opencode',
      '  model: invalid-model',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parallel-provider-model.yaml', [
      'name: parallel-provider-model',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    parallel:',
      '      - name: nested-review',
      '        uses: reviewer',
      '        rules:',
      '          - condition: done',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain("parallel sub-step \"nested-review\" of step \"review\".model must be in 'provider/model' format");
    expect(message).toContain('step fragment "reviewer"');
    expect(message).toContain(fragmentPath);
  });

  it('should attribute a parallel parent provider model validation error to its fragment model field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'provider:',
      '  type: opencode',
      '  model: invalid-model',
      'parallel:',
      '  - name: nested-review',
      '    instruction: review',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parallel-parent-provider-model.yaml', [
      'name: parallel-parent-provider-model',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      self:',
      '        - condition: done',
      '          next: COMPLETE',
      '      parallel:',
      '        nested-review:',
      '          - condition: done',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain("step \"review\".model must be in 'provider/model' format");
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('should attribute a rule-selected auto-routing model error to its fragment model field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'model: sonnet',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/auto-routing-fragment.yaml', [
      'name: auto-routing-fragment',
      'initial_step: review',
      'auto_routing:',
      '  strategy: balanced',
      '  router:',
      '    provider: claude-sdk',
      '    model: claude-haiku-4-5-20251001',
      '  candidates:',
      '    - name: codex',
      '      description: Codex candidate',
      '      provider: codex',
      '      model: gpt-5-codex',
      '      routing_tier: medium',
      '  default_pool: general',
      '  candidate_pools:',
      '    general:',
      '      candidates: [codex]',
      '      fallback: codex',
      '  rules:',
      '    steps:',
      '      review: codex',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain("auto_routing resolved model 'sonnet' is a Claude model alias but provider is 'codex'");
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('should attribute a default-pool auto-routing model error in a parallel sub-step to its fragment model field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/reviewer.yaml', [
      'instruction: review',
      'model: sonnet',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parallel-auto-routing-fragment.yaml', [
      'name: parallel-auto-routing-fragment',
      'initial_step: review',
      'auto_routing:',
      '  strategy: balanced',
      '  router:',
      '    provider: claude-sdk',
      '    model: claude-haiku-4-5-20251001',
      '  candidates:',
      '    - name: codex',
      '      description: Codex candidate',
      '      provider: codex',
      '      model: gpt-5-codex',
      '      routing_tier: medium',
      '  default_pool: general',
      '  candidate_pools:',
      '    general:',
      '      candidates: [codex]',
      '      fallback: codex',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    parallel:',
      '      - name: nested-review',
      '        uses: reviewer',
      '        rules:',
      '          - condition: done',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain("auto_routing resolved model 'sonnet' is a Claude model alias but provider is 'codex'");
    expect(message).toContain('step fragment "reviewer"');
    expect(message).toContain(fragmentPath);
  });

  it('should attribute an inherited Finding Contract manager provider error to its workflow_call fragment override', async () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      'overrides:',
      '  provider:',
      '    type: opencode',
      '    model: invalid-model',
      '',
    ].join('\n'));
    const childPath = writeFile(projectDir, '.takt/workflows/child.yaml', [
      'name: child',
      'subworkflow:',
      '  callable: true',
      '  returns:',
      '    - done',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    rules:',
      '      - condition: done',
      '        return: done',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parent-manager.yaml', [
      'name: parent-manager',
      'initial_step: delegate',
      'finding_contract:',
      '  ledger_path: .takt/findings/ledger.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', {
      projectCwd: projectDir,
      provider: 'mock',
      model: 'mock-model',
      workflowCallResolver: () => loadWorkflowFromFile(childPath, projectDir),
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toContain('finding_contract.manager.model must be in \'provider/model\' format');
    expect(abortReasons[0]).toContain('step fragment "delegate"');
    expect(abortReasons[0]).toContain(fragmentPath);
  });

  it('should attribute an unknown workflow_call target to its fragment call field', async () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: missing-child',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parent-missing-child.yaml', [
      'name: parent-missing-child',
      'initial_step: delegate',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '      - condition: ABORT',
      '        next: ABORT',
      '',
    ].join('\n'));
    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', {
      projectCwd: projectDir,
      provider: 'mock',
      model: 'mock-model',
      workflowCallResolver: () => null,
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toContain('references unknown workflow "missing-child"');
    expect(abortReasons[0]).toContain(workflowPath);
    expect(abortReasons[0]).toContain('from step fragment "delegate"');
    expect(abortReasons[0]).toContain(fragmentPath);
  });

  it('does not attribute an inline child provider error to a valid workflow_call fragment override', async () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      'overrides:',
      '  provider:',
      '    type: opencode',
      '    model: opencode/valid-model',
      '',
    ].join('\n'));
    const childPath = writeFile(projectDir, '.takt/workflows/child.yaml', [
      'name: child',
      'subworkflow:',
      '  callable: true',
      '  returns:',
      '    - done',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    provider:',
      '      type: opencode',
      '      model: invalid-model',
      '    rules:',
      '      - condition: done',
      '        return: done',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parent-child-provider.yaml', [
      'name: parent-child-provider',
      'initial_step: delegate',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', {
      projectCwd: projectDir,
      provider: 'mock',
      model: 'mock-model',
      workflowCallResolver: () => loadWorkflowFromFile(childPath, projectDir),
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toContain('step "review".model must be in \'provider/model\' format');
    expect(abortReasons[0]).not.toContain('step fragment "delegate"');
    expect(abortReasons[0]).not.toContain(fragmentPath);
  });

  it('does not attribute a parent workflow_call override error to a child step fragment', async () => {
    const childFragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      '',
    ].join('\n'));
    const childPath = writeFile(projectDir, '.takt/workflows/child.yaml', [
      'name: child',
      'subworkflow:',
      '  callable: true',
      '  returns:',
      '    - done',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        return: done',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parent-inline-override.yaml', [
      'name: parent-inline-override',
      'initial_step: delegate',
      'steps:',
      '  - name: delegate',
      '    kind: workflow_call',
      '    call: child',
      '    overrides:',
      '      provider: opencode',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', {
      projectCwd: projectDir,
      provider: 'mock',
      model: 'mock-model',
      workflowCallResolver: () => loadWorkflowFromFile(childPath, projectDir),
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toContain("provider 'opencode' requires model");
    expect(abortReasons[0]).not.toContain('step fragment "review"');
    expect(abortReasons[0]).not.toContain(childFragmentPath);
  });

  it('attributes a parent fragment workflow_call override error only to the parent fragment', async () => {
    const parentFragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      'overrides:',
      '  provider: opencode',
      '',
    ].join('\n'));
    const childFragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      '',
    ].join('\n'));
    const childPath = writeFile(projectDir, '.takt/workflows/child.yaml', [
      'name: child',
      'subworkflow:',
      '  callable: true',
      '  returns:',
      '    - done',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        return: done',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parent-fragment-override.yaml', [
      'name: parent-fragment-override',
      'initial_step: delegate',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', {
      projectCwd: projectDir,
      provider: 'mock',
      model: 'mock-model',
      workflowCallResolver: () => loadWorkflowFromFile(childPath, projectDir),
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toContain("provider 'opencode' requires model");
    expect(abortReasons[0]).toContain('step fragment "delegate"');
    expect(abortReasons[0]).toContain(parentFragmentPath);
    expect(abortReasons[0]).not.toContain('step fragment "review"');
    expect(abortReasons[0]).not.toContain(childFragmentPath);
  });

  it('should preserve a child workflow load error without parent fragment provenance', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/workflows/child.yaml', [
      'name: child',
      'subworkflow:',
      '  callable: true',
      '  returns:',
      '    - done',
      'initial_step: review',
      'max_steps: invalid',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    rules:',
      '      - condition: done',
      '        return: done',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parent-child-load.yaml', [
      'name: parent-child-load',
      'initial_step: delegate',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    const step = workflow.steps[0];
    if (!step || step.kind !== 'workflow_call') {
      throw new Error('Expected workflow_call step');
    }

    const message = errorMessage(() => resolveWorkflowCallTarget(workflow, step, projectDir));

    expect(message).toContain('expected number');
    expect(message).not.toContain('step fragment "delegate"');
    expect(message).not.toContain(fragmentPath);
  });

  it('should attribute a workflow_call override provider error to its parent fragment', async () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      'overrides:',
      '  provider:',
      '    type: opencode',
      '    model: invalid-model',
      '',
    ].join('\n'));
    const childPath = writeFile(projectDir, '.takt/workflows/child.yaml', [
      'name: child',
      'subworkflow:',
      '  callable: true',
      '  returns:',
      '    - done',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    rules:',
      '      - condition: done',
      '        return: done',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parent.yaml', [
      'name: parent',
      'initial_step: delegate',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', {
      projectCwd: projectDir,
      provider: 'mock',
      model: 'mock-model',
      workflowCallResolver: () => loadWorkflowFromFile(childPath, projectDir),
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toContain("step \"review\".model must be in 'provider/model' format");
    expect(abortReasons[0]).toContain('step fragment "delegate"');
    expect(abortReasons[0]).toContain(fragmentPath);
  });

  it('retains fragment context for an invalid caller override', () => {
    writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/caller-override.yaml', [
      'name: caller-override',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '    team_leader:',
      '      mode: finding_contract_fix',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain('team_leader.mode "finding_contract_fix"');
    expect(message).toContain('step uses fragment "review"');
    expect(message).not.toContain('from step fragment "review"');
  });

  it('should preserve fragment provenance when adjudication step injection rejects a reserved name', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/adjudication.yaml', [
      'name: finding-conflict-adjudication',
      'instruction: invalid reserved step',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/reserved-name.yaml', [
      'name: reserved-name',
      'initial_step: review',
      'finding_contract:',
      '  ledger_path: .takt/findings/ledger.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    rules:',
      '      - condition: needs adjudication',
      '        next: finding-conflict-adjudication',
      '  - uses: adjudication',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain('reserved for the engine-synthesized conflict adjudication step');
    expect(message).toContain('step fragment "adjudication"');
    expect(message).toContain(fragmentPath);
  });

  const fragmentPolicyCases: Array<{
    title: string;
    fragment: string[];
    expected: string[];
    extraFiles?: Array<[string, string]>;
  }> = [
    {
      title: 'an Arpeggio source policy error to the fragment source field',
      fragment: [
        'instruction: review',
        'arpeggio:',
        '  source: custom-module',
        '  source_path: input.csv',
        '  template: prompt.md',
        '',
      ],
      expected: ['uses Arpeggio source "custom-module"'],
    },
    {
      title: 'an Arpeggio merge file policy error to the fragment merge file field',
      fragment: [
        'instruction: review',
        'arpeggio:',
        '  source: csv',
        '  source_path: input.csv',
        '  template: prompt.md',
        '  merge:',
        '    strategy: custom',
        '    file: merge.js',
        '',
      ],
      expected: ['uses Arpeggio merge.file'],
    },
    {
      title: 'an empty fragment tag to the tag entry that defines it',
      fragment: ['instruction: review', 'tags: ["   "]', ''],
      expected: ['empty tags entry'],
    },
    {
      title: 'an implicit stdio MCP policy error to the fragment server object',
      fragment: [
        'instruction: review',
        'mcp_servers:',
        '  local:',
        '    command: local-mcp',
        '',
      ],
      expected: ['uses MCP server "local" with transport "stdio"'],
    },
    {
      title: 'an explicit MCP transport policy error to the fragment transport field',
      fragment: [
        'instruction: review',
        'mcp_servers:',
        '  remote:',
        '    type: sse',
        '    url: https://example.invalid/mcp',
        '',
      ],
      expected: ['uses MCP server "remote" with transport "sse"'],
    },
    {
      title: 'an invalid team leader inspect tool to the fragment entry',
      fragment: [
        'instruction: review',
        'team_leader:',
        '  inspect_tools: [bash]',
        '',
      ],
      expected: ['team_leader.inspect_tools contains non-read-only tool "bash"'],
    },
    {
      title: 'an unresolved output contract order to the fragment order field',
      extraFiles: [['.takt/facets/output-contracts/empty-order.md', '']],
      fragment: [
        'instruction: review',
        'output_contracts:',
        '  report:',
        '    - name: review.md',
        '      format: review format',
        '      order: ../facets/output-contracts/empty-order.md',
        '',
      ],
      expected: ['Failed to resolve output contract order "../facets/output-contracts/empty-order.md"'],
    },
  ];

  it.each(fragmentPolicyCases)('attributes $title', ({ fragment, expected, extraFiles }) => {
    for (const [relativePath, content] of extraFiles ?? []) {
      writeFile(projectDir, relativePath, content);
    }
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', fragment.join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/default.yaml', standardWorkflowYaml('review'));

    const message = configErrorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    for (const text of expected) {
      expect(message).toContain(text);
    }
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  const nestedFragmentAttributionCases: Array<{
    title: string;
    files: Array<[string, string]>;
    attributed: string;
    unattributed: string;
    expected: string[];
  }> = [
    {
      title: 'an Arpeggio inline JavaScript policy error to the fragment that provides inline_js',
      files: [
        ['.takt/steps/inner.yaml', [
          'instruction: review',
          'arpeggio:',
          '  source: csv',
          '  source_path: input.csv',
          '  template: prompt.md',
          '  merge:',
          '    strategy: custom',
          '    inline_js: return items',
          '',
        ].join('\n')],
        ['.takt/steps/outer.yaml', 'uses: inner\narpeggio:\n  source: csv\n'],
      ],
      attributed: 'inner',
      unattributed: 'outer',
      expected: [],
    },
    {
      title: 'an overridden team leader persona error to the outer fragment',
      files: [
        ['.takt/outside.md', 'outside persona\n'],
        ['.takt/steps/inner.yaml', [
          'instruction: review',
          'team_leader:',
          '  persona: inner.md',
          '  part_tags: [review]',
          '',
        ].join('\n')],
        ['.takt/steps/outer.yaml', [
          'uses: inner',
          'team_leader:',
          '  persona: ../outside.md',
          '',
        ].join('\n')],
      ],
      attributed: 'outer',
      unattributed: 'inner',
      expected: [],
    },
    {
      title: 'overridden team leader part tags to the outer fragment',
      files: [
        ['.takt/steps/inner.yaml', [
          'instruction: review',
          'team_leader:',
          '  part_tags: [review]',
          '',
        ].join('\n')],
        ['.takt/steps/outer.yaml', [
          'uses: inner',
          'team_leader:',
          '  part_tags: ["   "]',
          '',
        ].join('\n')],
      ],
      attributed: 'outer',
      unattributed: 'inner',
      expected: ['team_leader.part_tags contains an empty entry'],
    },
  ];

  it.each(nestedFragmentAttributionCases)('attributes $title', ({ files, attributed, unattributed, expected }) => {
    const written = new Map<string, string>();
    for (const [relativePath, content] of files) {
      written.set(relativePath, writeFile(projectDir, relativePath, content));
    }
    const workflowPath = writeFile(projectDir, '.takt/workflows/default.yaml', standardWorkflowYaml('outer'));
    const attributedPath = written.get(`.takt/steps/${attributed}.yaml`);
    if (!attributedPath) throw new Error(`Missing fragment file for "${attributed}"`);

    const message = configErrorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    for (const text of expected) {
      expect(message).toContain(text);
    }
    expect(message).toContain(`step fragment "${attributed}"`);
    expect(message).toContain(attributedPath);
    expect(message).not.toContain(`step fragment "${unattributed}"`);
  });

  it('retains fragment context while identifying a caller-provided provider option reference error as workflow-defined', () => {
    writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    provider_options:',
      '      extends: missing-options',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = configErrorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('provider_options.extends not found: missing-options');
    expect(message).toContain('step uses fragment "review"');
    expect(message).toContain('defined by the workflow');
  });

  it('does not associate a fragment when engine provider metadata has no source', () => {
    writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = configErrorMessage(() => new WorkflowEngine(
      loadWorkflowFromFile(workflowPath, projectDir),
      projectDir,
      'test task',
      {
        projectCwd: projectDir,
        provider: 'opencode',
      },
    ));

    expect(message).toContain("provider 'opencode' requires model");
    expect(message).not.toContain('step fragment "review"');
  });

  it('attributes a missing OpenCode promotion model to the outer fragment that provides the provider', () => {
    writeFile(projectDir, '.takt/steps/inner.yaml', [
      'instruction: review',
      'promotion:',
      '  - at: 2',
      '    provider: claude',
      '',
    ].join('\n'));
    const outerPath = writeFile(projectDir, '.takt/steps/outer.yaml', [
      'uses: inner',
      'promotion:',
      '  - at: 2',
      '    provider: opencode',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    uses: outer',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = configEngineError(workflowPath, projectDir);

    expect(message).toContain("provider 'opencode' requires model");
    expect(message).toContain('step fragment "outer"');
    expect(message).toContain(outerPath);
    expect(message).not.toContain('step fragment "inner"');
  });

  it('retains fragment context while identifying a caller replacement promotion as workflow-defined', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'promotion:',
      '  - at: 2',
      '    provider: claude',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    promotion:',
      '      - at: 2',
      '        provider: opencode',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = configEngineError(workflowPath, projectDir);

    expect(message).toContain("provider 'opencode' requires model");
    expect(message).toContain(workflowPath);
    expect(message).toContain('step uses fragment "review"');
    expect(message).toContain(fragmentPath);
    expect(message).toContain('defined by the workflow');
  });

  it('retains fragment context while identifying a caller workflow call override as workflow-defined', async () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      'overrides:',
      '  provider: claude',
      '',
    ].join('\n'));
    const childPath = writeFile(projectDir, '.takt/workflows/child.yaml', [
      'name: child',
      'subworkflow:',
      '  callable: true',
      'initial_step: review',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parent-caller-override.yaml', [
      'name: parent-caller-override',
      'initial_step: delegate',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    overrides:',
      '      provider: opencode',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const engine = new WorkflowEngine(loadWorkflowFromFile(workflowPath, projectDir), projectDir, 'test task', {
      projectCwd: projectDir,
      provider: 'mock',
      model: 'mock-model',
      workflowCallResolver: () => loadWorkflowFromFile(childPath, projectDir),
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toContain("provider 'opencode' requires model");
    expect(abortReasons[0]).toContain(workflowPath);
    expect(abortReasons[0]).toContain('step uses fragment "delegate"');
    expect(abortReasons[0]).toContain(fragmentPath);
    expect(abortReasons[0]).toContain('defined by the workflow');
  });

  it('keeps an aggregate rule placement error owned by the workflow caller', () => {
    const rulePath = writeFile(projectDir, '.takt/steps/rules.yaml', [
      'instruction: review',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/steps/outer.yaml', 'uses: rules\npersona: reviewer\n');
    const workflowPath = writeFile(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: outer',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = configEngineError(workflowPath, projectDir);

    expect(message).toContain('aggregate conditions');
    expect(message).not.toContain(rulePath);
    expect(message).not.toContain('step fragment');
  });

  it.each([
    {
      name: 'top-level step',
      step: '  - name: review\n    uses: outer\n    rules:\n      - condition: approved\n        appendix: first\n        next: COMPLETE\n      - condition: approved\n        appendix: second\n        next: COMPLETE',
      fragment: 'instruction: review\n',
    },
    {
      name: 'parallel sub-step',
      step: '  - name: reviewers\n    parallel:\n      - name: review\n        uses: outer\n        rules:\n          - condition: approved\n            appendix: first\n            next: COMPLETE\n          - condition: approved\n            appendix: second\n            next: COMPLETE\n    rules:\n      - condition: all("approved")\n        next: COMPLETE',
      fragment: 'instruction: review\n',
    },
  ])('keeps a semantic appendix conflict in a $name owned by the workflow caller', ({ step, fragment }) => {
    const rulePath = writeFile(projectDir, '.takt/steps/rules.yaml', fragment);
    writeFile(projectDir, '.takt/steps/outer.yaml', 'uses: rules\npersona: reviewer\n');
    const workflowPath = writeFile(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      step,
      '',
    ].join('\n'));

    const message = configEngineError(workflowPath, projectDir);

    expect(message).toContain('Rules sharing semantic label "approved" must use the same appendix');
    expect(message).not.toContain(rulePath);
    expect(message).not.toContain('step fragment');
  });

  it.each([
    {
      name: 'top-level step',
      initialStep: 'review',
      step: '  - uses: review\n    name: review\n    rules:\n      - condition: all("approved")\n        next: COMPLETE',
    },
    {
      name: 'parallel sub-step',
      initialStep: 'reviewers',
      step: '  - name: reviewers\n    parallel:\n      - uses: review\n        name: review\n        rules:\n          - condition: all("approved")\n            next: COMPLETE',
    },
  ])('retains fragment context while identifying a caller rule override as workflow-defined in a $name', ({ initialStep, step }) => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      `initial_step: ${initialStep}`,
      'max_steps: 1',
      'steps:',
      step,
      '',
    ].join('\n'));

    const message = configEngineError(workflowPath, projectDir);

    expect(message).toContain('aggregate conditions');
    expect(message).not.toContain('step uses fragment "review"');
    expect(message).not.toContain(fragmentPath);
  });
});

describe('workflow step fragment provider provenance translation', () => {
  it.each([
    'cli',
    'env',
    'auto.rules',
    'auto.dynamic',
    'auto.fallback',
    'workflow',
    'project',
    'global',
    'default',
  ] as const satisfies readonly ProviderResolutionSource[])('does not associate a fragment with a %s provider validation error', (providerSource) => {
    const raw = { steps: [{ provider: 'claude' }] };
    const workflow = {} as WorkflowConfig;
    registerWorkflowStepFragmentErrorContext(
      workflow,
      [{ stepPath: ['steps', 0, 'provider'], ref: 'review', sourcePath: '/fragments/review.yaml' }],
      raw,
      '/workflows/default.yaml',
    );
    const validationError = withProviderValidationErrorSource(
      withWorkflowConfigErrorPath(new Error("provider 'opencode' requires model"), ['steps', 0, 'provider']),
      {
        provider: 'opencode',
        model: undefined,
        providerSource,
        modelSource: undefined,
      },
    );

    const translated = translateWorkflowStepFragmentError(workflow, validationError);

    expect(translated).toBe(validationError);
  });

  it('attributes a fragment field when a configuration error has no provider metadata', () => {
    const raw = { steps: [{ instruction: 'review' }] };
    const workflow = {} as WorkflowConfig;
    registerWorkflowStepFragmentErrorContext(
      workflow,
      [{ stepPath: ['steps', 0, 'instruction'], ref: 'review', sourcePath: '/fragments/review.yaml' }],
      raw,
      '/workflows/default.yaml',
    );
    const configurationError = withWorkflowConfigErrorPath(
      new Error('invalid instruction'),
      ['steps', 0, 'instruction'],
    );

    const translated = translateWorkflowStepFragmentError(workflow, configurationError);

    expect(translated).not.toBe(configurationError);
    expect(translated.message).toContain('from step fragment "review" at /fragments/review.yaml');
  });

  it('associates a missing provider with the provider field even when a model is present', () => {
    const error = withProviderValidationErrorSource(new Error('provider is required'), {
      provider: undefined,
      model: 'model-without-provider',
      providerSource: undefined,
      modelSource: 'step',
    });

    expect(getProviderValidationErrorSource(error)).toMatchObject({
      field: 'provider',
      source: undefined,
    });
  });
});
