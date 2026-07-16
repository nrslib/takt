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
    fix_instruction:
      type: facet_ref
      facet_kind: instruction
    review_report_format:
      type: facet_ref
      facet_kind: report_format
initial_step: review
max_steps: 3
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
    persona: reviewer
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
      policyContents: [expect.stringContaining('strict child review checklist')],
      knowledgeContents: [expect.stringContaining('Architecture reference content')],
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
      knowledgeContents: [expect.stringContaining('Domain reference content')],
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
      policyContents: [expect.stringContaining('relaxed child policy')],
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
      policyContents: [expect.stringContaining('strict child review checklist')],
      knowledgeContents: [expect.stringContaining('Architecture reference content')],
    });
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
        knowledgeContents: [expect.stringContaining('Project child local knowledge.')],
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
