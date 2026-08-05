import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as workflowCallContracts from '../infra/config/loaders/workflowCallContracts.js';
import * as workflowCallResolver from '../infra/config/loaders/workflowCallResolver.js';
import * as workflowCallableArgResolver from '../infra/config/loaders/workflowCallableArgResolver.js';
import * as workflowLoader from '../infra/config/loaders/workflowLoader.js';
import * as workflowResolver from '../infra/config/loaders/workflowResolver.js';
import { getWorkflowSourcePath } from '../infra/config/loaders/workflowSourceMetadata.js';
import { getWorkflowTrustInfo, resolveWorkflowTrustInfo } from '../infra/config/loaders/workflowTrustSource.js';
import type { WorkflowConfig } from '../core/models/index.js';
import type { AutoRoutingConfig } from '../core/models/config-types.js';
import { findWorkflowCallStep } from './testUtils/workflowCallStepTestHelper.js';

describe('workflowCallResolver module boundary', () => {
  let projectDir: string;
  let externalDir: string;

  function writeProjectWorkflow(relativePath: string, content: string): string {
    const filePath = join(projectDir, '.takt', 'workflows', relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  function loadProjectWorkflow(relativePath: string) {
    return workflowLoader.loadWorkflowFromFile(join(projectDir, '.takt', 'workflows', relativePath), projectDir);
  }

  function loadWorktreeWorkflow(worktreeDir: string, relativePath: string) {
    const filePath = join(worktreeDir, '.takt', 'workflows', relativePath);
    return workflowLoader.loadWorkflowFromFile(filePath, projectDir, {
      trustInfo: resolveWorkflowTrustInfo({
        filePath,
        projectCwd: projectDir,
        lookupCwd: worktreeDir,
      }),
    });
  }

  function writeFindingContractCallFixture(
    overridesYaml: string,
    childAutoRoutingYaml = '',
  ): void {
    writeProjectWorkflow('root.yaml', `name: root
finding_contract:
  manager:
    persona: findings-manager
    instruction: findings-manager
    output_contract: findings-manager
    provider: codex
    model: gpt-5
  adjudicator:
    persona: supervisor
    instruction: adjudicate
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: child
${overridesYaml}    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('child.yaml', `name: child
subworkflow:
  callable: true
${childAutoRoutingYaml}initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: Review.
    rules:
      - condition: done
        next: COMPLETE
`);
  }

  function syntheticRoleAutoRouting(
    provider: 'codex' | 'opencode',
    strategy: AutoRoutingConfig['strategy'],
  ): AutoRoutingConfig {
    const candidateName = `${provider}-synthetic`;
    return {
      strategy,
      router: { provider: 'claude-sdk', model: 'claude-haiku-4-5-20251001' },
      candidates: [{
        name: candidateName,
        provider,
        model: provider === 'opencode' ? 'opencode/good' : 'gpt-5',
        routingTier: 'medium',
      }],
      defaultPool: 'synthetic',
      candidatePools: {
        synthetic: { candidates: [candidateName], fallback: candidateName },
      },
      rules: {
        steps: { 'findings-terminal-adjudication': candidateName },
      },
    };
  }

  function childAutoRoutingYaml(
    provider: 'codex' | 'opencode',
    strategy: AutoRoutingConfig['strategy'],
  ): string {
    const candidateName = `${provider}-synthetic`;
    const model = provider === 'opencode' ? 'opencode/good' : 'gpt-5';
    return `auto_routing:
  strategy: ${strategy}
  router:
    provider: claude-sdk
    model: claude-haiku-4-5-20251001
  candidates:
    - name: ${candidateName}
      provider: ${provider}
      model: ${model}
      routing_tier: medium
  default_pool: synthetic
  candidate_pools:
    synthetic:
      candidates: [${candidateName}]
      fallback: ${candidateName}
  rules:
    steps:
      findings-terminal-adjudication: ${candidateName}
`;
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-project-'));
    externalDir = mkdtempSync(join(tmpdir(), 'takt-external-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  });

  it('keeps workflow_call resolution in the dedicated module while workflowLoader re-exports it', () => {
    expect(workflowResolver).not.toHaveProperty('resolveWorkflowCallTarget');
    expect(workflowResolver).toHaveProperty('loadWorkflowByIdentifierForWorkflowCall');
    expect(workflowCallResolver).toHaveProperty('resolveWorkflowCallTarget');
    expect(workflowCallableArgResolver).toHaveProperty('expandCallableSubworkflowRaw');
    expect(workflowCallContracts).toHaveProperty('validateWorkflowCallRulesAgainstChildReturns');
    expect(workflowLoader.resolveWorkflowCallTarget).toBe(workflowCallResolver.resolveWorkflowCallTarget);
    expect(workflowLoader).not.toHaveProperty('loadWorkflowByIdentifierForWorkflowCall');
    expect(workflowLoader).not.toHaveProperty('expandCallableSubworkflowRaw');
    expect(workflowLoader).not.toHaveProperty('validateWorkflowCallRulesAgainstChildReturns');
  });

  it('loads a callable command quality gate with timeout_ms through workflow_call resolution', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    writeProjectWorkflow('child.yaml', `name: child
subworkflow:
  callable: true
  visibility: internal
initial_step: implement
max_steps: 3
steps:
  - name: implement
    persona: coder
    edit: true
    quality_gates:
      - type: command
        name: quality-check
        command: "./.takt/quality-gates/check.sh"
        timeout_ms: 900000
    instruction: Implement the feature
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFileSync(
      join(projectDir, '.takt', 'config.yaml'),
      'workflow_command_gates:\n  custom_scripts: true\n',
      'utf-8',
    );

    const parentWorkflow = loadProjectWorkflow('parent.yaml');
    expect(parentWorkflow).not.toBeNull();

    const childWorkflow = workflowCallResolver.resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate'),
      projectDir,
      projectDir,
    );

    expect(childWorkflow).not.toBeNull();
    expect(childWorkflow!.steps.find((step) => step.name === 'implement')?.qualityGates).toEqual([
      {
        type: 'command',
        name: 'quality-check',
        command: './.takt/quality-gates/check.sh',
        timeoutMs: 900000,
      },
    ]);
  });

  it('normalizes callable result labels consistently across child declarations and parent conditions', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: " ok "
        next: COMPLETE
`);
    writeProjectWorkflow('child.yaml', `name: child
subworkflow:
  callable: true
  returns: [" ok "]
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: Review the task
    rules:
      - condition: done
        return: " ok "
`);

    const parentWorkflow = loadProjectWorkflow('parent.yaml');
    expect(parentWorkflow).not.toBeNull();

    const delegate = findWorkflowCallStep(parentWorkflow!, 'delegate');
    const childWorkflow = workflowCallResolver.resolveWorkflowCallTarget(
      parentWorkflow!,
      delegate,
      projectDir,
      projectDir,
    );

    expect(delegate.rules?.[0]?.condition).toEqual({ kind: 'semantic', label: 'ok' });
    expect(childWorkflow?.subworkflow?.returns).toEqual(['ok']);
    expect(childWorkflow?.steps[0]?.rules?.[0]?.returnValue).toBe('ok');
  });

  it('rejects a Finding Contract subworkflow when its caller does not provide the required contract', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    writeProjectWorkflow('child.yaml', `name: child
subworkflow:
  callable: true
  visibility: internal
  requires_finding_contract: true
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: Review with the inherited ledger
    rules:
      - condition: when(findings.open.count == 0)
        next: COMPLETE
`);

    const parent = loadProjectWorkflow('parent.yaml');
    expect(() => workflowResolver.validateWorkflowCallContracts(parent, projectDir)).toThrow(
      /workflow "child".*requires a finding_contract inherited from its caller/s,
    );
  });

  it('prefers parent workflow metadata over fallback context for nested relative workflow_call resolution', () => {
    const rootWorkflowPath = join(externalDir, 'root.yaml');
    const childWorkflowPath = join(externalDir, 'child', 'child.yaml');
    const nestedWorkflowPath = join(externalDir, 'child', 'nested.yaml');
    const wrongNestedWorkflowPath = join(externalDir, 'nested.yaml');

    mkdirSync(dirname(childWorkflowPath), { recursive: true });

    writeFileSync(rootWorkflowPath, `name: external-root
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ./child/child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeFileSync(childWorkflowPath, `name: external-child
subworkflow:
  callable: true
initial_step: delegate_nested
max_steps: 3
steps:
  - name: delegate_nested
    kind: workflow_call
    call: ./nested.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeFileSync(nestedWorkflowPath, `name: nested-child
subworkflow:
  callable: true
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: nested-reviewer
    instruction: "Nested child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeFileSync(wrongNestedWorkflowPath, `name: wrong-nested-child
subworkflow:
  callable: true
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: wrong-reviewer
    instruction: "Wrong nested child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const rootWorkflow = workflowLoader.loadWorkflowByIdentifier(rootWorkflowPath, projectDir);
    expect(rootWorkflow).not.toBeNull();

    const childWorkflow = workflowLoader.loadWorkflowByIdentifier(childWorkflowPath, projectDir);
    expect(childWorkflow).not.toBeNull();
    expect(getWorkflowSourcePath(childWorkflow!)).toBe(childWorkflowPath);

    const resolvedNestedWorkflow = workflowCallResolver.resolveWorkflowCallTarget(
      childWorkflow!,
      findWorkflowCallStep(childWorkflow!, 'delegate_nested'),
      projectDir,
      projectDir,
      {
        sourcePath: getWorkflowSourcePath(rootWorkflow!)!,
        trustInfo: getWorkflowTrustInfo(rootWorkflow!, projectDir),
      },
    );

    expect(resolvedNestedWorkflow).not.toBeNull();
    expect(resolvedNestedWorkflow?.name).toBe('nested-child');
  });

  it('expands workflow_call args into child $param fields before normalization', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: shared/review-loop
    args:
      review_policy: [strict-review]
      review_persona: delegated-reviewer
      fix_instruction: child-fix
      review_report_format: summary
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    writeProjectWorkflow('shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  visibility: internal
  returns: [ok, retry_plan]
  params:
    review_policy:
      type: facet_ref[]
      facet_kind: policy
    review_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
      default: [architecture]
    review_persona:
      type: facet_ref
      facet_kind: persona
    fix_instruction:
      type: facet_ref
      facet_kind: instruction
    review_report_format:
      type: facet_ref
      facet_kind: report_format
initial_step: review
max_steps: 3
personas:
  delegated-reviewer: |
    Review the delegated change.
policies:
  strict-review: |
    Follow the strict child review checklist.
knowledge:
  architecture: |
    Architecture reference content.
instructions:
  child-fix: |
    Fix child issues with the delegated instruction.
report_formats:
  summary: |
    # Summary Format
steps:
  - name: review
    persona:
      $param: review_persona
    policy:
      $param: review_policy
    knowledge:
      $param: review_knowledge
    instruction: Review child workflow
    rules:
      - condition: done
        return: ok
  - name: fix
    persona: coder
    instruction:
      $param: fix_instruction
    output_contracts:
      report:
        - name: summary
          format:
            $param: review_report_format
    rules:
      - condition: done
        return: retry_plan
`);

    const parentWorkflow = loadProjectWorkflow('parent.yaml');
    expect(parentWorkflow).not.toBeNull();

    const childWorkflow = workflowCallResolver.resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate'),
      projectDir,
      projectDir,
    );

    expect(childWorkflow).not.toBeNull();
    expect((childWorkflow!.subworkflow as Record<string, unknown>)?.visibility).toBe('internal');
    expect((childWorkflow!.subworkflow as Record<string, unknown>)?.returns).toEqual(['ok', 'retry_plan']);

    const reviewStep = childWorkflow!.steps.find((step) => step.name === 'review') as Record<string, unknown> | undefined;
    const fixStep = childWorkflow!.steps.find((step) => step.name === 'fix') as Record<string, unknown> | undefined;

    expect(reviewStep).toMatchObject({
      persona: expect.stringContaining('Review the delegated change'),
      policyContents: [expect.objectContaining({ content: expect.stringContaining('strict child review checklist') })],
      knowledgeContents: [expect.objectContaining({ content: expect.stringContaining('Architecture reference content') })],
    });
    expect(fixStep).toMatchObject({
      instruction: expect.stringContaining('delegated instruction'),
      outputContracts: [
        expect.objectContaining({
          name: 'summary',
          format: expect.stringContaining('# Summary Format'),
        }),
      ],
    });
  });

  it('expands callable $param values inside nested workflow_call args', () => {
    writeProjectWorkflow('root.yaml', `name: root
initial_step: delegate_parent
max_steps: 3
steps:
  - name: delegate_parent
    kind: workflow_call
    call: parent
    args:
      parent_knowledge: [domain]
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    writeProjectWorkflow('parent.yaml', `name: parent
subworkflow:
  callable: true
  params:
    parent_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
      default: [architecture]
initial_step: delegate_child
max_steps: 3
knowledge:
  architecture: |
    Architecture reference content.
  domain: |
    Domain reference content.
steps:
  - name: delegate_child
    kind: workflow_call
    call: child
    args:
      child_knowledge:
        $param: parent_knowledge
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    writeProjectWorkflow('child.yaml', `name: child
subworkflow:
  callable: true
  params:
    child_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
initial_step: review
max_steps: 3
knowledge:
  domain: |
    Domain reference content.
steps:
  - name: review
    persona: reviewer
    knowledge:
      $param: child_knowledge
    instruction: Review child workflow
    rules:
      - condition: done
        next: COMPLETE
`);

    const rootWorkflow = loadProjectWorkflow('root.yaml');
    expect(rootWorkflow).not.toBeNull();

    const parentWorkflow = workflowCallResolver.resolveWorkflowCallTarget(
      rootWorkflow!,
      findWorkflowCallStep(rootWorkflow!, 'delegate_parent'),
      projectDir,
      projectDir,
    );
    expect(parentWorkflow).not.toBeNull();

    const childWorkflow = workflowCallResolver.resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate_child'),
      projectDir,
      projectDir,
    );
    expect(childWorkflow).not.toBeNull();

    const reviewStep = childWorkflow!.steps.find((step) => step.name === 'review') as Record<string, unknown> | undefined;
    expect(reviewStep).toMatchObject({
      knowledgeContents: [expect.objectContaining({ content: expect.stringContaining('Domain reference content') })],
    });
  });

  it('resolves same-named workflow_call sub-steps from separate parallel parents by the provided step identity', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: fanout_a
max_steps: 3
steps:
  - name: fanout_a
    parallel:
      - name: delegate
        kind: workflow_call
        call: child-a
        args:
          review_policy: strict-review
        rules:
          - condition: COMPLETE
            next: fanout_b
    rules:
      - condition: all("COMPLETE")
        next: fanout_b
  - name: fanout_b
    parallel:
      - name: delegate
        kind: workflow_call
        call: child-b
        args:
          review_policy: relaxed-review
        rules:
          - condition: COMPLETE
            next: COMPLETE
    rules:
      - condition: all("COMPLETE")
        next: COMPLETE
`);
    writeProjectWorkflow('child-b.yaml', `name: child-b
subworkflow:
  callable: true
  returns: [ok]
  params:
    review_policy:
      type: facet_ref
      facet_kind: policy
initial_step: review
max_steps: 3
policies:
  relaxed-review: |
    Use the relaxed child policy.
steps:
  - name: review
    persona: reviewer
    policy:
      $param: review_policy
    instruction: Review child workflow
    rules:
      - condition: done
        return: ok
`);

    const parentWorkflow = loadProjectWorkflow('parent.yaml');
    expect(parentWorkflow).not.toBeNull();

    const childWorkflow = workflowCallResolver.resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate', 'child-b'),
      projectDir,
      projectDir,
    );

    expect(childWorkflow).not.toBeNull();
    expect(childWorkflow?.name).toBe('child-b');
    expect(childWorkflow?.steps[0]).toMatchObject({
      policyContents: [expect.objectContaining({ content: expect.stringContaining('relaxed child policy') })],
    });
  });

  it('expands scalar facet_ref args into child policy and knowledge fields', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: shared/scalar-review
    args:
      review_policy: strict-review
      review_knowledge: architecture
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    writeProjectWorkflow('shared/scalar-review.yaml', `name: shared/scalar-review
subworkflow:
  callable: true
  returns: [ok]
  params:
    review_policy:
      type: facet_ref
      facet_kind: policy
    review_knowledge:
      type: facet_ref
      facet_kind: knowledge
initial_step: review
max_steps: 3
policies:
  strict-review: |
    Follow the strict child review checklist.
knowledge:
  architecture: |
    Architecture reference content.
steps:
  - name: review
    persona: reviewer
    policy:
      $param: review_policy
    knowledge:
      $param: review_knowledge
    instruction: Review child workflow
    rules:
      - condition: done
        return: ok
`);

    const parentWorkflow = loadProjectWorkflow('parent.yaml');
    expect(parentWorkflow).not.toBeNull();

    const childWorkflow = workflowCallResolver.resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate'),
      projectDir,
      projectDir,
    );

    expect(childWorkflow).not.toBeNull();

    const reviewStep = childWorkflow!.steps.find((step) => step.name === 'review') as Record<string, unknown> | undefined;

    expect(reviewStep).toMatchObject({
      policyContents: [expect.objectContaining({ content: expect.stringContaining('strict child review checklist') })],
      knowledgeContents: [expect.objectContaining({ content: expect.stringContaining('Architecture reference content') })],
    });
  });

  it('flattens scalar and array facet params in declaration order', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: composed-review
    args:
      policy_additions: [domain-policy-a, domain-policy-b]
      knowledge_addition: domain-knowledge
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('composed-review.yaml', `name: composed-review
subworkflow:
  callable: true
  params:
    policy_additions:
      type: facet_ref[]
      facet_kind: policy
    knowledge_addition:
      type: facet_ref
      facet_kind: knowledge
policies:
  base-policy: Base policy
  domain-policy-a: Domain policy A
  domain-policy-b: Domain policy B
  final-policy: Final policy
knowledge:
  base-knowledge: Base knowledge
  domain-knowledge: Domain knowledge
  final-knowledge: Final knowledge
steps:
  - name: review
    persona: reviewer
    policy:
      - base-policy
      - $param: policy_additions
      - final-policy
    knowledge:
      - base-knowledge
      - $param: knowledge_addition
      - final-knowledge
    instruction: Review
    rules:
      - condition: done
        next: COMPLETE
`);

    const parent = loadProjectWorkflow('parent.yaml');
    const child = workflowCallResolver.resolveWorkflowCallTarget(
      parent!,
      findWorkflowCallStep(parent!, 'delegate'),
      projectDir,
      projectDir,
    );

    expect(child?.steps[0]?.policyContents?.map((r) => r.content)).toEqual([
      'Base policy',
      'Domain policy A',
      'Domain policy B',
      'Final policy',
    ]);
    expect(child?.steps[0]?.knowledgeContents?.map((r) => r.content)).toEqual([
      'Base knowledge',
      'Domain knowledge',
      'Final knowledge',
    ]);
  });

  it('accepts empty facet_ref arrays from args and defaults when fixed refs remain', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: composed-review
    args:
      knowledge_additions: []
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('composed-review.yaml', `name: composed-review
subworkflow:
  callable: true
  params:
    policy_additions:
      type: facet_ref[]
      facet_kind: policy
      default: []
    knowledge_additions:
      type: facet_ref[]
      facet_kind: knowledge
policies:
  base-policy: Base policy
knowledge:
  base-knowledge: Base knowledge
steps:
  - name: review
    persona: reviewer
    policy:
      - base-policy
      - $param: policy_additions
    knowledge:
      - base-knowledge
      - $param: knowledge_additions
    instruction: Review
    rules:
      - condition: done
        next: COMPLETE
`);

    const parent = loadProjectWorkflow('parent.yaml');
    const child = workflowCallResolver.resolveWorkflowCallTarget(
      parent!,
      findWorkflowCallStep(parent!, 'delegate'),
      projectDir,
      projectDir,
    );

    expect(child?.steps[0]?.policyContents?.map((r) => r.content)).toEqual(['Base policy']);
    expect(child?.steps[0]?.knowledgeContents?.map((r) => r.content)).toEqual(['Base knowledge']);
  });

  it('resolves a workflow_ref param before the nested workflow_call target boundary', () => {
    writeProjectWorkflow('root.yaml', `name: root
initial_step: compose
steps:
  - name: compose
    kind: workflow_call
    call: composer
    args:
      target: implementation
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('composer.yaml', `name: composer
subworkflow:
  callable: true
  params:
    target:
      type: workflow_ref
steps:
  - name: delegate
    kind: workflow_call
    call:
      $param: target
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('implementation.yaml', `name: implementation
subworkflow:
  callable: true
steps:
  - name: implement
    persona: coder
    instruction: Implement
    rules:
      - condition: done
        next: COMPLETE
`);

    const root = loadProjectWorkflow('root.yaml');
    const composer = workflowCallResolver.resolveWorkflowCallTarget(
      root!,
      findWorkflowCallStep(root!, 'compose'),
      projectDir,
      projectDir,
    );
    const delegate = findWorkflowCallStep(composer!, 'delegate');
    const implementation = workflowCallResolver.resolveWorkflowCallTarget(
      composer!,
      delegate,
      projectDir,
      projectDir,
    );

    expect(delegate.call).toBe('implementation');
    expect(implementation?.name).toBe('implementation');
  });

  it('validates required Finding Contracts for each expanded workflow_ref invocation', () => {
    writeProjectWorkflow('root.yaml', `name: root
initial_step: compose-safe
steps:
  - name: compose-safe
    kind: workflow_call
    call: composer
    args:
      target: safe-review
    rules:
      - condition: COMPLETE
        next: compose-required
  - name: compose-required
    kind: workflow_call
    call: composer
    args:
      target: required-review
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('composer.yaml', `name: composer
subworkflow:
  callable: true
  params:
    target:
      type: workflow_ref
steps:
  - name: delegate
    kind: workflow_call
    call:
      $param: target
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('safe-review.yaml', `name: safe-review
subworkflow:
  callable: true
steps:
  - name: review
    persona: reviewer
    instruction: Review without a Finding Contract
    rules:
      - condition: done
        next: COMPLETE
`);
    writeProjectWorkflow('required-review.yaml', `name: required-review
subworkflow:
  callable: true
  requires_finding_contract: true
steps:
  - name: review
    persona: reviewer
    instruction: Review with the inherited Finding Contract
    rules:
      - condition: when(findings.open.count == 0)
        next: COMPLETE
`);

    const root = loadProjectWorkflow('root.yaml');

    expect(() => workflowResolver.validateWorkflowCallContracts(root, projectDir)).toThrow(
      /workflow "required-review".*requires a finding_contract inherited from its caller/s,
    );
  });

  it.each([
    { nested: false, terminalAuthority: false },
    { nested: false, terminalAuthority: true },
    { nested: true, terminalAuthority: false },
    { nested: true, terminalAuthority: true },
  ])(
    'accepts routing that makes an inherited terminal role valid (nested=$nested, terminal=$terminalAuthority)',
    ({ nested, terminalAuthority }) => {
      const authorityLine = terminalAuthority
        ? '    finding_contract_authority: terminal_adjudication\n'
        : '';
      writeProjectWorkflow('root.yaml', `name: root
workflow_config:
  provider: claude
finding_contract:
  manager:
    persona: findings-manager
    instruction: findings-manager
    output_contract: findings-manager
    provider: codex
    model: strong-manager
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: ${nested ? 'outer' : 'inner'}
${nested ? '' : authorityLine}    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
      if (nested) {
        writeProjectWorkflow('outer.yaml', `name: outer
workflow_config:
  provider: claude
subworkflow:
  callable: true
initial_step: delegate-inner
steps:
  - name: delegate-inner
    kind: workflow_call
    call: inner
${authorityLine}    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
      }
      writeProjectWorkflow('inner.yaml', `name: inner
workflow_config:
  provider: opencode
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: Review.
    rules:
      - condition: done
        next: COMPLETE
`);

      const root = loadProjectWorkflow('root.yaml');

      expect(() => workflowResolver.validateWorkflowCallContracts(root, projectDir, projectDir, {
        providerValidationOptions: {
          provider: 'claude',
          providerSource: 'project',
          providerRouting: {
            personas: {
              supervisor: { provider: 'codex', model: 'strong-adjudicator' },
            },
          },
        },
      })).not.toThrow();
    },
  );

  it('rejects an inherited role when workflow_call provider override invalidates valid base routing', () => {
    writeFindingContractCallFixture(`    overrides:
      provider: opencode
`);
    const root = loadProjectWorkflow('root.yaml');

    expect(() => workflowResolver.validateWorkflowCallContracts(root, projectDir, projectDir, {
      providerValidationOptions: {
        providerRouting: {
          personas: {
            supervisor: { provider: 'codex', model: 'gpt-5' },
          },
        },
      },
    })).toThrow(/provider 'opencode' requires model/);
  });

  it('accepts an inherited role when workflow_call overrides repair invalid base routing', () => {
    writeFindingContractCallFixture(`    overrides:
      provider: codex
      model: gpt-5
`);
    const root = loadProjectWorkflow('root.yaml');

    expect(() => workflowResolver.validateWorkflowCallContracts(root, projectDir, projectDir, {
      providerValidationOptions: {
        providerRouting: {
          personas: {
            supervisor: { provider: 'opencode' },
          },
        },
      },
    })).not.toThrow();
  });

  it('rejects using child auto_routing instead of valid inherited auto routing', () => {
    writeFindingContractCallFixture(`    overrides:
      model: bare-model
`, childAutoRoutingYaml('opencode', 'performance'));
    const root = loadProjectWorkflow('root.yaml');

    expect(() => workflowResolver.validateWorkflowCallContracts(root, projectDir, projectDir, {
      providerValidationOptions: {
        autoRouting: syntheticRoleAutoRouting('codex', 'cost'),
      },
    })).toThrow(/auto_routing resolved model.*provider\/model/);
  });

  it('accepts using child auto_routing instead of invalid inherited auto routing', () => {
    writeFindingContractCallFixture(`    overrides:
      model: bare-model
`, childAutoRoutingYaml('codex', 'cost'));
    const root = loadProjectWorkflow('root.yaml');

    expect(() => workflowResolver.validateWorkflowCallContracts(root, projectDir, projectDir, {
      providerValidationOptions: {
        autoRouting: syntheticRoleAutoRouting('opencode', 'performance'),
      },
    })).not.toThrow();
  });

  it.each([
    { nested: false, terminalAuthority: false },
    { nested: false, terminalAuthority: true },
    { nested: true, terminalAuthority: false },
    { nested: true, terminalAuthority: true },
  ])(
    'rejects routing that makes an inherited terminal role invalid before execution (nested=$nested, terminal=$terminalAuthority)',
    ({ nested, terminalAuthority }) => {
      const authorityLine = terminalAuthority
        ? '    finding_contract_authority: terminal_adjudication\n'
        : '';
      writeProjectWorkflow('root.yaml', `name: root
workflow_config:
  provider: claude
finding_contract:
  manager:
    persona: findings-manager
    instruction: findings-manager
    output_contract: findings-manager
    provider: codex
    model: strong-manager
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: ${nested ? 'outer' : 'inner'}
${nested ? '' : authorityLine}    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
      if (nested) {
        writeProjectWorkflow('outer.yaml', `name: outer
workflow_config:
  provider: claude
subworkflow:
  callable: true
initial_step: delegate-inner
steps:
  - name: delegate-inner
    kind: workflow_call
    call: inner
${authorityLine}    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
      }
      writeProjectWorkflow('inner.yaml', `name: inner
workflow_config:
  provider: claude
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: Review.
    rules:
      - condition: done
        next: COMPLETE
`);

      const root = loadProjectWorkflow('root.yaml');

      expect(() => workflowResolver.validateWorkflowCallContracts(root, projectDir, projectDir, {
        providerValidationOptions: {
          provider: 'claude',
          providerSource: 'project',
          providerRouting: {
            personas: {
              supervisor: { provider: 'opencode' },
            },
          },
        },
      })).toThrow(/provider 'opencode' requires model/);
    },
  );

  it('does not apply terminal validation to a sibling without an effective contract or conflict route', () => {
    writeProjectWorkflow('root.yaml', `name: root
workflow_config:
  provider: claude
initial_step: fc-child
steps:
  - name: fc-child
    kind: workflow_call
    call: local-fc
    rules:
      - condition: COMPLETE
        next: plain-child
  - name: plain-child
    kind: workflow_call
    call: plain
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('local-fc.yaml', `name: local-fc
subworkflow:
  callable: true
finding_contract:
  manager:
    persona: findings-manager
    instruction: findings-manager
    output_contract: findings-manager
    provider: codex
    model: strong-manager
  adjudicator:
    persona: supervisor
    instruction: adjudicate
    provider: codex
    model: strong-adjudicator
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: Review.
    rules:
      - condition: done
        next: COMPLETE
`);
    writeProjectWorkflow('plain.yaml', `name: plain
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: Review.
    rules:
      - condition: done
        next: COMPLETE
`);

    const root = loadProjectWorkflow('root.yaml');

    expect(() => workflowResolver.validateWorkflowCallContracts(root, projectDir, projectDir, {
      providerValidationOptions: {
        provider: 'claude',
        providerRouting: {
          personas: {
            supervisor: { provider: 'opencode' },
          },
        },
      },
    })).not.toThrow();
  });

  it('validates nested return routes for each expanded workflow_ref invocation', () => {
    writeProjectWorkflow('root.yaml', `name: root
initial_step: compose-accepted
steps:
  - name: compose-accepted
    kind: workflow_call
    call: composer
    args:
      target: accepted-review
    rules:
      - condition: COMPLETE
        next: compose-rejected
  - name: compose-rejected
    kind: workflow_call
    call: composer
    args:
      target: rejected-review
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('composer.yaml', `name: composer
subworkflow:
  callable: true
  params:
    target:
      type: workflow_ref
steps:
  - name: delegate
    kind: workflow_call
    call:
      $param: target
    rules:
      - condition: accepted
        next: COMPLETE
`);
    writeProjectWorkflow('accepted-review.yaml', `name: accepted-review
subworkflow:
  callable: true
  returns: [accepted]
steps:
  - name: review
    persona: reviewer
    instruction: Review and accept
    rules:
      - condition: done
        return: accepted
`);
    writeProjectWorkflow('rejected-review.yaml', `name: rejected-review
subworkflow:
  callable: true
  returns: [rejected]
steps:
  - name: review
    persona: reviewer
    instruction: Review and reject
    rules:
      - condition: done
        return: rejected
`);

    const root = loadProjectWorkflow('root.yaml');

    expect(() => workflowResolver.validateWorkflowCallContracts(root, projectDir)).toThrow(
      'workflow_call step "delegate" cannot route on unsupported child result "accepted"',
    );
  });

  it('rejects recursive workflow_call validation cycles without unbounded recursion', () => {
    writeProjectWorkflow('root.yaml', `name: root
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: recursive-review
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('recursive-review.yaml', `name: recursive-review
subworkflow:
  callable: true
steps:
  - name: recurse
    kind: workflow_call
    call: recursive-review
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

    const root = loadProjectWorkflow('root.yaml');

    expect(() => workflowResolver.validateWorkflowCallContracts(root, projectDir)).toThrow(
      'Configuration error: recursive workflow_call cycle detected at workflow "recursive-review"',
    );
  });

  it.each([
    {
      name: 'array value',
      args: '    args:\n      target: [implementation]\n',
    },
    {
      name: 'missing value',
      args: '',
    },
  ])('rejects a workflow_ref param with $name', ({ args }) => {
    writeProjectWorkflow('root.yaml', `name: root
initial_step: compose
steps:
  - name: compose
    kind: workflow_call
    call: composer
${args}    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('composer.yaml', `name: composer
subworkflow:
  callable: true
  params:
    target:
      type: workflow_ref
steps:
  - name: delegate
    kind: workflow_call
    call:
      $param: target
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

    const root = loadProjectWorkflow('root.yaml');

    expect(() => workflowCallResolver.resolveWorkflowCallTarget(
      root!,
      findWorkflowCallStep(root!, 'compose'),
      projectDir,
      projectDir,
    )).toThrow();
  });

  it('rejects a facet param used as a workflow_call target', () => {
    writeProjectWorkflow('root.yaml', `name: root
initial_step: compose
steps:
  - name: compose
    kind: workflow_call
    call: composer
    args:
      target: strict
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('composer.yaml', `name: composer
subworkflow:
  callable: true
  params:
    target:
      type: facet_ref
      facet_kind: policy
policies:
  strict: Strict policy
steps:
  - name: delegate
    kind: workflow_call
    call:
      $param: target
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

    const root = loadProjectWorkflow('root.yaml');

    expect(() => workflowCallResolver.resolveWorkflowCallTarget(
      root!,
      findWorkflowCallStep(root!, 'compose'),
      projectDir,
      projectDir,
    )).toThrow();
  });

  it('rejects undeclared workflow_call args during child workflow resolution', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: shared/review-loop
    args:
      unknown_param: summary
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    writeProjectWorkflow('shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  returns: [ok]
  params:
    review_report_format:
      type: facet_ref
      facet_kind: report_format
initial_step: review
max_steps: 3
report_formats:
  summary: |
    # Summary Format
steps:
  - name: review
    persona: reviewer
    instruction: Review child workflow
    rules:
      - condition: done
        return: ok
`);

    const parentWorkflow = loadProjectWorkflow('parent.yaml');
    expect(parentWorkflow).not.toBeNull();

    expect(() => workflowCallResolver.resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate'),
      projectDir,
      projectDir,
    )).toThrow(/unknown_param/);
  });

  it('rejects facet_ref[] params when workflow_call args pass a scalar facet ref', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: shared/review-loop
    args:
      review_knowledge: architecture
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  returns: [ok]
  params:
    review_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
initial_step: review
max_steps: 3
knowledge:
  architecture: |
    Architecture reference content.
steps:
  - name: review
    persona: reviewer
    knowledge:
      $param: review_knowledge
    instruction: Review child workflow
    rules:
      - condition: done
        return: ok
`);

    const parentWorkflow = loadProjectWorkflow('parent.yaml');
    expect(parentWorkflow).not.toBeNull();

    expect(() => workflowCallResolver.resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate'),
      projectDir,
      projectDir,
    )).toThrow(/must be a facet_ref\[\] array/);
  });

  it('rejects scalar facet_ref params when workflow_call args pass an array', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: shared/review-loop
    args:
      review_policy: [strict-review]
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  returns: [ok]
  params:
    review_policy:
      type: facet_ref
      facet_kind: policy
initial_step: review
max_steps: 3
policies:
  strict-review: |
    Follow the strict child review checklist.
steps:
  - name: review
    persona: reviewer
    policy:
      $param: review_policy
    instruction: Review child workflow
    rules:
      - condition: done
        return: ok
`);

    const parentWorkflow = loadProjectWorkflow('parent.yaml');
    expect(parentWorkflow).not.toBeNull();

    expect(() => workflowCallResolver.resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate'),
      projectDir,
      projectDir,
    )).toThrow(/must be a scalar facet_ref/);
  });

  it('rejects facet kind mismatches when child steps bind knowledge params into instruction fields', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: shared/review-loop
    args:
      review_knowledge: architecture
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  returns: [ok]
  params:
    review_knowledge:
      type: facet_ref
      facet_kind: knowledge
initial_step: review
max_steps: 3
knowledge:
  architecture: |
    Architecture reference content.
steps:
  - name: review
    persona: reviewer
    instruction:
      $param: review_knowledge
    rules:
      - condition: done
        return: ok
`);

    const parentWorkflow = loadProjectWorkflow('parent.yaml');
    expect(parentWorkflow).not.toBeNull();

    expect(() => workflowCallResolver.resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate'),
      projectDir,
      projectDir,
    )).toThrow(/expects instruction to use instruction param "review_knowledge"/);
  });

  it('rejects callable subworkflows that require args omitted by the parent workflow_call', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: shared/review-loop
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  returns: [ok]
  params:
    fix_instruction:
      type: facet_ref
      facet_kind: instruction
initial_step: review
max_steps: 3
instructions:
  child-fix: |
    Fix child issues.
steps:
  - name: review
    persona: reviewer
    instruction:
      $param: fix_instruction
    rules:
      - condition: done
        return: ok
`);

    const parentWorkflow = loadProjectWorkflow('parent.yaml');
    expect(parentWorkflow).not.toBeNull();

    expect(() => workflowCallResolver.resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate'),
      projectDir,
      projectDir,
    )).toThrow(/requires workflow_call arg "fix_instruction"/);
  });

  it('rejects child workflows that reference undeclared $param names', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: shared/review-loop
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  returns: [ok]
  params:
    review_knowledge:
      type: facet_ref
      facet_kind: knowledge
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    knowledge:
      $param: missing_knowledge
    instruction: Review child workflow
    rules:
      - condition: done
        return: ok
`);

    const parentWorkflow = loadProjectWorkflow('parent.yaml');
    expect(parentWorkflow).not.toBeNull();

    expect(() => workflowCallResolver.resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate'),
      projectDir,
      projectDir,
    )).toThrow(/references undeclared param "missing_knowledge"/);
  });

  it('rejects facet kind mismatches when workflow_call args pass refs of the wrong facet kind', () => {
    writeProjectWorkflow('parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: shared/review-loop
    args:
      review_knowledge: strict-review
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeProjectWorkflow('shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  returns: [ok]
  params:
    review_knowledge:
      type: facet_ref
      facet_kind: knowledge
initial_step: review
max_steps: 3
policies:
  strict-review: |
    This is a policy, not knowledge.
steps:
  - name: review
    persona: reviewer
    knowledge:
      $param: review_knowledge
    instruction: Review child workflow
    rules:
      - condition: done
        return: ok
`);

    const parentWorkflow = loadProjectWorkflow('parent.yaml');
    expect(parentWorkflow).not.toBeNull();

    expect(() => workflowCallResolver.resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate'),
      projectDir,
      projectDir,
    )).toThrow(/unknown knowledge facet "strict-review"/);
  });

  it('allows child-local facet args when a worktree parent crosses into a project child', () => {
    const worktreeDir = mkdtempSync(join(tmpdir(), 'takt-worktree-'));
    try {
      writeProjectWorkflow('shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  returns: [ok]
  params:
    review_knowledge:
      type: facet_ref
      facet_kind: knowledge
initial_step: review
max_steps: 3
knowledge:
  local-review: |
    Project child local knowledge.
steps:
  - name: review
    persona: reviewer
    knowledge:
      $param: review_knowledge
    instruction: Review child workflow
    rules:
      - condition: done
        return: ok
`);
      const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');
      mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
      writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: shared/review-loop
    args:
      review_knowledge: local-review
    rules:
      - condition: COMPLETE
        next: COMPLETE
`, 'utf-8');

      const parentWorkflow = loadWorktreeWorkflow(worktreeDir, 'parent.yaml');
      expect(parentWorkflow).not.toBeNull();

      const childWorkflow = workflowCallResolver.resolveWorkflowCallTarget(
        parentWorkflow!,
        findWorkflowCallStep(parentWorkflow!, 'delegate'),
        projectDir,
        worktreeDir,
      );

      expect(childWorkflow).not.toBeNull();
      expect(childWorkflow?.steps[0]).toMatchObject({
        knowledgeContents: [expect.objectContaining({ content: expect.stringContaining('Project child local knowledge.') })],
      });
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it('rejects non-local facet args when a worktree parent crosses into a project child', () => {
    const worktreeDir = mkdtempSync(join(tmpdir(), 'takt-worktree-'));
    try {
      writeProjectWorkflow('shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  returns: [ok]
  params:
    review_knowledge:
      type: facet_ref
      facet_kind: knowledge
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    knowledge:
      $param: review_knowledge
    instruction: Review child workflow
    rules:
      - condition: done
        return: ok
`);
      mkdirSync(join(projectDir, '.takt', 'facets', 'knowledge'), { recursive: true });
      writeFileSync(
        join(projectDir, '.takt', 'facets', 'knowledge', 'architecture.md'),
        'Architecture from project facets.',
        'utf-8',
      );
      const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');
      mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
      writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: shared/review-loop
    args:
      review_knowledge: architecture
    rules:
      - condition: COMPLETE
        next: COMPLETE
`, 'utf-8');

      const parentWorkflow = loadWorktreeWorkflow(worktreeDir, 'parent.yaml');
      expect(parentWorkflow).not.toBeNull();

      expect(() => workflowCallResolver.resolveWorkflowCallTarget(
        parentWorkflow!,
        findWorkflowCallStep(parentWorkflow!, 'delegate'),
        projectDir,
        worktreeDir,
      )).toThrow(/must reference child-local knowledge facet "architecture" across trust boundary/);
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it('rejects path-like facet args when a worktree parent crosses into a project child', () => {
    const worktreeDir = mkdtempSync(join(tmpdir(), 'takt-worktree-'));
    try {
      writeProjectWorkflow('shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  returns: [ok]
  params:
    review_instruction:
      type: facet_ref
      facet_kind: instruction
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction:
      $param: review_instruction
    rules:
      - condition: done
        return: ok
`);
      const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');
      mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
      writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: shared/review-loop
    args:
      review_instruction: ../../secret.md
    rules:
      - condition: COMPLETE
        next: COMPLETE
`, 'utf-8');

      const parentWorkflow = loadWorktreeWorkflow(worktreeDir, 'parent.yaml');
      expect(parentWorkflow).not.toBeNull();

      expect(() => workflowCallResolver.resolveWorkflowCallTarget(
        parentWorkflow!,
        findWorkflowCallStep(parentWorkflow!, 'delegate'),
        projectDir,
        worktreeDir,
      )).toThrow(/must reference child-local instruction facet "\.\.\/\.\.\/secret\.md" across trust boundary/);
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });
});
