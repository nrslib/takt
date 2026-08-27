/**
 * Tests for workflow loader path detection and identifier resolution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

import {
  isDynamicParallelSubSteps,
  type ParallelWorkflowStep,
  type WorkflowConfig,
  type WorkflowStep,
} from '../core/models/index.js';

import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import {
  isWorkflowPath,
  loadAllWorkflowDiscovery,
  loadAllWorkflowDiscoveryWithSources,
  loadAllStandaloneWorkflows,
  loadAllStandaloneWorkflowsWithSources,
  loadWorkflow,
  loadWorkflowFromFile,
  loadWorkflowByIdentifier,
  resolveWorkflowCallTarget,
  listStandaloneWorkflowEntries,
  listWorkflows,
  listWorkflowEntries,
  loadAllWorkflows,
  loadAllWorkflowsWithSources,
} from '../infra/config/loaders/workflowLoader.js';
import { getWorkflowTrustInfo } from '../infra/config/loaders/workflowTrustSource.js';
import {
  materializeWorkflowMakerArtifact,
  planWorkflowMakerArtifact,
} from '../features/workflowMaker/index.js';
import { prepareWorkflowExecutionBundle } from '../features/tasks/execute/workflowExecutionBundle.js';
import { ReportInstructionBuilder } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import { findAgentWorkflowStep, findWorkflowStep } from './test-helpers.js';

function setBuiltinWorkflowsEnabledForTest(enabled: boolean): void {
  const configDir = process.env.TAKT_CONFIG_DIR;
  if (!configDir) {
    throw new Error('TAKT_CONFIG_DIR is required for workflow loader tests');
  }
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), `enable_builtin_workflows: ${enabled ? 'true' : 'false'}\n`, 'utf-8');
  invalidateGlobalConfigCache();
}

afterEach(() => {
  invalidateGlobalConfigCache();
});

const SAMPLE_WORKFLOW = `name: test-workflow
description: Test workflow
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`;

const INVALID_ALLOWED_TOOLS_WORKFLOW = `name: broken-workflow
description: Broken workflow
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    allowed_tools: [Read]
    instruction: "{task}"
`;

function semanticTransitionMap(step: WorkflowStep): Record<string, string | undefined> {
  return Object.fromEntries((step.rules ?? []).map((rule) => {
    if (rule.condition.kind !== 'semantic') {
      throw new Error(`Expected semantic transition rule on workflow step "${step.name}"`);
    }
    return [rule.condition.label, rule.next];
  }));
}

function writeWorkflowCallContractChildFixture(workflowsDir: string): void {
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, 'child.yaml'), `name: child
subworkflow:
  callable: true
  returns: [ok]
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: "Review"
    rules:
      - condition: done
        return: ok
`);
}

function writeInvalidWorkflowCallContractFixture(workflowsDir: string): void {
  writeWorkflowCallContractChildFixture(workflowsDir);
  writeFileSync(join(workflowsDir, 'parent.yaml'), `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: retry_plan
        next: COMPLETE
`);
}

function writeInvalidParallelWorkflowCallContractFixture(workflowsDir: string): void {
  writeWorkflowCallContractChildFixture(workflowsDir);
  writeFileSync(join(workflowsDir, 'parent.yaml'), `name: parent
initial_step: fanout
max_steps: 3
steps:
  - name: fanout
    parallel:
      - name: delegate
        kind: workflow_call
        call: child
        rules:
          - condition: retry_plan
            next: COMPLETE
    rules:
      - condition: all("ok")
        next: COMPLETE
`);
}

describe('isWorkflowPath', () => {
  it('should return true for absolute paths', () => {
    expect(isWorkflowPath('/path/to/workflow.yaml')).toBe(true);
    expect(isWorkflowPath('/workflow')).toBe(true);
  });

  it('should return true for home directory paths', () => {
    expect(isWorkflowPath('~/workflow.yaml')).toBe(true);
    expect(isWorkflowPath('~/.takt/workflows/custom.yaml')).toBe(true);
  });

  it('should return true for relative paths starting with ./', () => {
    expect(isWorkflowPath('./workflow.yaml')).toBe(true);
    expect(isWorkflowPath('./subdir/workflow.yaml')).toBe(true);
  });

  it('should return true for relative paths starting with ../', () => {
    expect(isWorkflowPath('../workflow.yaml')).toBe(true);
    expect(isWorkflowPath('../subdir/workflow.yaml')).toBe(true);
  });

  it('should return true for paths ending with .yaml', () => {
    expect(isWorkflowPath('custom.yaml')).toBe(true);
    expect(isWorkflowPath('my-workflow.yaml')).toBe(true);
  });

  it('should return true for paths ending with .yml', () => {
    expect(isWorkflowPath('custom.yml')).toBe(true);
    expect(isWorkflowPath('my-workflow.yml')).toBe(true);
  });

  it('should return false for plain workflow names', () => {
    expect(isWorkflowPath('default')).toBe(false);
    expect(isWorkflowPath('simple')).toBe(false);
    expect(isWorkflowPath('magi')).toBe(false);
    expect(isWorkflowPath('my-custom-workflow')).toBe(false);
  });
});

describe('loadWorkflowByIdentifier', () => {
  let tempDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
    process.env.TAKT_CONFIG_DIR = join(tempDir, 'global-takt');
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load workflow by name (builtin)', () => {
    const workflow = loadWorkflowByIdentifier('default', process.cwd());
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('default');
  });

  it('should load the loop analysis builtin workflow', () => {
    const workflow = loadWorkflowByIdentifier('loop-analysis', process.cwd());

    expect(workflow?.name).toBe('loop-analysis');
  });

  it.each(['en', 'ja'] as const)(
    'loads the bounded Workflow Maker review loop with shared guidance (%s)',
    (language) => {
      const projectDir = join(tempDir, language);
      mkdirSync(join(projectDir, '.takt'), { recursive: true });
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`, 'utf-8');

      const workflow = loadWorkflowByIdentifier('workflow-maker', projectDir);
      if (!workflow) {
        throw new Error(`Expected builtin workflow "workflow-maker" for language "${language}"`);
      }

      expect(workflow.initialStep).toBe('create');
      expect(workflow.steps.map((step) => step.name)).toEqual(['create', 'review', 'fix']);
      expect(workflow.maxSteps).not.toBe('infinite');
      expect(workflow.maxSteps).toEqual(expect.any(Number));
      expect(workflow.maxSteps).toBeGreaterThan(0);

      const create = findAgentWorkflowStep(workflow, 'create');
      const review = findAgentWorkflowStep(workflow, 'review');
      const fix = findAgentWorkflowStep(workflow, 'fix');
      expect(Object.values(semanticTransitionMap(create))).toContain('review');
      expect(Object.values(semanticTransitionMap(review))).toEqual(
        expect.arrayContaining(['fix', 'COMPLETE']),
      );
      expect(Object.values(semanticTransitionMap(fix))).toContain('review');

      for (const step of [create, review, fix]) {
        expect(step.qualityGates ?? []).toEqual([]);
        expect(step.rules?.every((rule) => rule.commandGates !== 'required')).toBe(true);
      }

      const sharedRefs = (
        key: 'policyContents' | 'knowledgeContents',
      ): string[] => {
        const steps = [create, review, fix];
        const first = new Set(
          (create[key] ?? [])
            .map((entry) => entry.refName)
            .filter((ref): ref is string => ref !== undefined),
        );
        const remaining = steps.slice(1)
          .map((step) => new Set(
            (step[key] ?? [])
              .map((entry) => entry.refName)
              .filter((ref): ref is string => ref !== undefined),
          ));
        return [...first].filter((ref) => remaining.every((refs) => refs.has(ref)));
      };
      expect(sharedRefs('policyContents')).toContain('takt');
      expect(sharedRefs('knowledgeContents')).toContain('takt');
      const builtinRoot = join(process.cwd(), 'builtins', language, 'facets', 'output-contracts');
      const doctorFormat = readFileSync(join(builtinRoot, 'workflow-maker-doctor.md'), 'utf-8');
      const reviewFormat = readFileSync(join(builtinRoot, 'workflow-maker-review.md'), 'utf-8');
      expect(create.outputContracts).toEqual([{
        name: 'workflow-maker-doctor.md',
        useJudge: true,
        format: doctorFormat,
        formatRef: 'doctor',
        order: undefined,
        orderRef: undefined,
      }]);
      expect(review.outputContracts).toEqual([{
        name: 'workflow-maker-review.md',
        useJudge: true,
        format: reviewFormat,
        formatRef: 'review',
        order: undefined,
        orderRef: undefined,
      }]);
      expect(fix.outputContracts).toEqual(create.outputContracts);
      expect(review.instruction).toContain('workflow-maker-doctor.md');
      expect(review.instruction).toContain('FAIL');
      expect(review.instruction).toContain('needs_fix');
      expect(review.instruction).toContain('PASS');
      expect(review.instruction).toContain('approved');
      if (language === 'en') {
        expect(review.instruction).toContain('missing or unreadable');
      } else {
        expect(review.instruction).toContain('存在しない、読み取れない');
      }
    },
  );

  it.each(['en', 'ja'] as const)('loads builtin reports with default judgment inclusion (%s)', (language) => {
    const projectDir = join(tempDir, language);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`, 'utf-8');

    const workflow = loadWorkflowByIdentifier('simple', projectDir);
    if (!workflow) {
      throw new Error(`Expected builtin workflow "simple" for language "${language}"`);
    }

    const supervise = findWorkflowStep(workflow, 'supervise');
    const summary = supervise.outputContracts?.find((contract) => contract.name === 'summary.md');
    expect(summary?.useJudge).toBe(true);
  });

  it('TEST-NEW-review-fix-contract keeps review-fix aligned with default peer-review wiring', () => {
    for (const language of ['en', 'ja'] as const) {
      const projectDir = join(tempDir, language);
      mkdirSync(join(projectDir, '.takt'), { recursive: true });
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`, 'utf-8');

      const defaultWorkflow = loadWorkflowByIdentifier('default', projectDir);
      const reviewWorkflow = loadWorkflowByIdentifier('review', projectDir);
      const reviewFixWorkflow = loadWorkflowByIdentifier('review-fix', projectDir);
      if (!defaultWorkflow || !reviewWorkflow || !reviewFixWorkflow) {
        throw new Error(`Expected builtin workflows to load for language "${language}"`);
      }

      const defaultDevelop = findWorkflowStep(defaultWorkflow, 'develop');
      if (defaultDevelop.kind !== 'workflow_call') {
        throw new Error('Expected default.develop to be a workflow_call step');
      }
      const developmentCore = resolveWorkflowCallTarget(defaultWorkflow, defaultDevelop, projectDir, projectDir);
      if (!developmentCore) {
        throw new Error('Expected default.develop to resolve development-core');
      }

      const defaultPeerReview = findWorkflowStep(developmentCore, 'peer-review');
      const reviewFixReviewers = findWorkflowStep(reviewFixWorkflow, 'reviewers');
      if (defaultPeerReview.kind !== 'workflow_call' || reviewFixReviewers.kind !== 'workflow_call') {
        throw new Error('Expected peer-review and reviewers to be workflow_call steps');
      }

      expect(reviewFixReviewers.call).toBe('peer-review');
      expect(reviewFixReviewers.args).toEqual(defaultPeerReview.args);
      expect(reviewFixReviewers.args?.reviewer_suite).toBe('development-review');

      const reviewGather = findWorkflowStep(reviewWorkflow, 'gather');
      const reviewFixGather = findWorkflowStep(reviewFixWorkflow, 'gather');
      expect(reviewFixGather.instructionRef).toBe(reviewGather.instructionRef);
      expect(reviewFixGather.instruction).toBe(reviewGather.instruction);
      expect(reviewFixGather.rules).toEqual(reviewGather.rules);

      expect(semanticTransitionMap(reviewFixReviewers)).toEqual({
        COMPLETE: 'COMPLETE',
        need_replan: 'ABORT',
        ABORT: 'ABORT',
      });
    }
  });

  it('loads Team Leader Companion selections through the English and Japanese builtin wiring', () => {
    const expectedSelection = {
      fixed: ['ai-antipattern-review-companion', 'testing-review-companion'],
      pool: [],
      moderator: 'review-companion-moderator',
    };

    for (const language of ['en', 'ja'] as const) {
      const projectDir = join(tempDir, language);
      mkdirSync(join(projectDir, '.takt'), { recursive: true });
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`, 'utf-8');

      const implementation = loadWorkflowFromFile(
        join(process.cwd(), 'builtins', language, 'workflows', 'development-implement-team.yaml'),
        projectDir,
        { callableArgs: { implementation_companions: ['ai-antipattern-review-companion'] } },
      );
      const remediation = loadWorkflowFromFile(
        join(process.cwd(), 'builtins', language, 'workflows', 'development-remediation-team.yaml'),
        projectDir,
        { callableArgs: { fix_companions: ['testing-review-companion'] } },
      );
      const defaultTeam = loadWorkflowByIdentifier('takt-default-team', projectDir);

      const implementationStep = findAgentWorkflowStep(implementation, 'implement');
      const fixStep = findAgentWorkflowStep(remediation, 'fix');
      const retryStep = findAgentWorkflowStep(remediation, 'fix-retry');
      const developStep = findWorkflowStep(defaultTeam!, 'develop');

      expect(implementationStep.companion).toEqual({
        fixed: ['ai-antipattern-review-companion'],
        pool: [],
      });
      expect(fixStep.companion).toEqual({ fixed: ['testing-review-companion'], pool: [] });
      expect(retryStep.companion).toEqual({ fixed: ['testing-review-companion'], pool: [] });
      if (developStep.kind !== 'workflow_call') {
        throw new Error('Expected default team develop to be a workflow_call step');
      }
      expect(developStep.args).toEqual(expect.objectContaining({
        implementation_companions: expectedSelection,
      }));
      expect(developStep.args).not.toHaveProperty('fix_companions');
    }
  });

  it('should load workflow by absolute path', () => {
    const filePath = join(tempDir, 'test.yaml');
    writeFileSync(filePath, SAMPLE_WORKFLOW);

    const workflow = loadWorkflowByIdentifier(filePath, tempDir);
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('test-workflow');
  });

  it('should reject workflow provider/model settings and point to runtime.yaml', () => {
    const filePath = join(tempDir, 'model-null.yaml');
    writeFileSync(filePath, `name: model-null
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    provider: cursor
    model: null
    instruction: "{task}"
`);

    expect(() => loadWorkflowByIdentifier(filePath, tempDir)).toThrow(/runtime\.yaml/);
  });

  it('should reject callable section map project facet symlinks before expanding workflow_call defaults', () => {
    const workflowsDir = join(tempDir, '.takt', 'workflows');
    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    const outsideDir = join(tempDir, 'outside');
    mkdirSync(workflowsDir, { recursive: true });
    mkdirSync(instructionsDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'secret.md'), 'Secret instruction', 'utf-8');
    symlinkSync(join(outsideDir, 'secret.md'), join(instructionsDir, 'linked.md'));
    const filePath = join(workflowsDir, 'callable-default.yaml');
    writeFileSync(filePath, `name: callable-default
subworkflow:
  callable: true
  params:
    review_instruction:
      type: facet_ref
      facet_kind: instruction
      default: linked
max_steps: 1
initial_step: review
instructions:
  linked: ../facets/instructions/linked.md
steps:
  - name: review
    instruction:
      $param: review_instruction
`);

    expect(() => loadWorkflowByIdentifier(filePath, tempDir)).toThrow(
      /Project facet file must stay inside the project and must not use symlinks/,
    );
  });

  it('should load privileged system workflows from arbitrary project paths', () => {
    const filePath = join(tempDir, 'unsafe-system.yaml');
    writeFileSync(filePath, `name: unsafe-system
initial_step: route_context
max_steps: 2

steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - condition: "when(true)"
        next: COMPLETE
`);

    const workflow = loadWorkflowByIdentifier(filePath, tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('unsafe-system');
    expect(workflow!.steps[0]?.kind).toBe('system');
  });

  it('should load privileged system workflows from arbitrary relative project paths', () => {
    writeFileSync(join(tempDir, 'unsafe-system.yaml'), `name: unsafe-system
initial_step: route_context
max_steps: 2

steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - condition: "when(true)"
        next: COMPLETE
`);

    const workflow = loadWorkflowByIdentifier('./unsafe-system.yaml', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('unsafe-system');
    expect(workflow!.steps[0]?.kind).toBe('system');
  });

  it('should load allow_git_commit workflows from arbitrary project absolute paths', () => {
    const filePath = join(tempDir, 'unsafe-commit.yaml');
    writeFileSync(filePath, `name: unsafe-commit
initial_step: implement
max_steps: 2

steps:
  - name: implement
    persona: coder
    allow_git_commit: true
    instruction: "{task}"
`);

    const workflow = loadWorkflowByIdentifier(filePath, tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('unsafe-commit');
    expect(workflow!.steps[0]?.allowGitCommit).toBe(true);
  });

  it('should load allow_git_commit workflows from arbitrary project relative paths', () => {
    writeFileSync(join(tempDir, 'unsafe-commit.yaml'), `name: unsafe-commit
initial_step: implement
max_steps: 2

steps:
  - name: implement
    persona: coder
    allow_git_commit: true
    instruction: "{task}"
`);

    const workflow = loadWorkflowByIdentifier('./unsafe-commit.yaml', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('unsafe-commit');
    expect(workflow!.steps[0]?.allowGitCommit).toBe(true);
  });

  it('should load system-input workflows from arbitrary project paths', () => {
    const filePath = join(tempDir, 'unsafe-system-inputs.yaml');
    writeFileSync(filePath, `name: unsafe-system-inputs
initial_step: route_context
max_steps: 2

steps:
  - name: route_context
    mode: system
    system_inputs:
      - type: pr_context
        source: current_branch
        as: pr
    rules:
      - condition: "when(true)"
        next: COMPLETE
`);

    const workflow = loadWorkflowByIdentifier(filePath, tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('unsafe-system-inputs');
    expect(workflow!.steps[0]?.kind).toBe('system');
  });

  it('should load workflow by relative path', () => {
    const filePath = join(tempDir, 'test.yaml');
    writeFileSync(filePath, SAMPLE_WORKFLOW);

    const workflow = loadWorkflowByIdentifier('./test.yaml', tempDir);
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('test-workflow');
  });

  it('should load workflow by filename with .yaml extension', () => {
    const filePath = join(tempDir, 'test.yaml');
    writeFileSync(filePath, SAMPLE_WORKFLOW);

    const workflow = loadWorkflowByIdentifier('test.yaml', tempDir);
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('test-workflow');
  });

  it('should return null for non-existent name', () => {
    const workflow = loadWorkflowByIdentifier('non-existent-workflow-xyz', process.cwd());
    expect(workflow).toBeNull();
  });

  it('should return null for non-existent path', () => {
    const workflow = loadWorkflowByIdentifier('./non-existent.yaml', tempDir);
    expect(workflow).toBeNull();
  });

  it('should load workflow definitions from project-local workflows directory', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'project-custom.yaml'), SAMPLE_WORKFLOW);

    const workflow = loadWorkflowByIdentifier('project-custom', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('test-workflow');
  });

  it('should reject callable subworkflow provider settings and point to runtime.yaml', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'callable-provider.yaml'), `name: callable-provider
subworkflow:
  callable: true
workflow_config:
  provider: codex
  model: gpt-5-codex
  provider_options:
    codex:
      network_access: true
initial_step: review
max_steps: 2
loop_monitors:
  - cycle: [review, review]
    threshold: 2
    judge:
      provider:
        type: codex
        network_access: true
      model: gpt-5-codex
      rules:
        - condition: stop
          next: ABORT
steps:
  - name: review
    persona: reviewer
    provider: codex
    model: gpt-5-codex
    provider_options:
      codex:
        network_access: true
    instruction: Review
    parallel:
      - name: security
        persona: security-reviewer
        provider: codex
        model: gpt-5-codex
        provider_options:
          codex:
            network_access: true
        instruction: Security review
    rules:
      - condition: done
        next: COMPLETE
`);

    expect(() => loadWorkflowByIdentifier('callable-provider', tempDir)).toThrow(/runtime\.yaml/);
  });

  it('should reject unsupported workflow_call child return conditions during load', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'child.yaml'), `name: child
subworkflow:
  callable: true
  returns: [ok]
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: "Review"
    rules:
      - condition: done
        return: ok
`);
    writeFileSync(join(projectWorkflowsDir, 'parent.yaml'), `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: retry_plan
        next: COMPLETE
`);

    expect(() => loadWorkflowByIdentifier('parent', tempDir)).toThrow(
      'workflow_call step "delegate" cannot route on unsupported child result "retry_plan"',
    );
  });

  it('should reject reserved callable return names during load', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'child.yaml'), `name: child
subworkflow:
  callable: true
  returns: [ABORT]
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: "Review"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFileSync(join(projectWorkflowsDir, 'parent.yaml'), `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: ABORT
        next: ABORT
`);

    try {
      loadWorkflowByIdentifier('parent', tempDir);
      expect.unreachable('expected loadWorkflowByIdentifier to throw');
    } catch (error) {
      expect(String(error)).toContain('subworkflow.returns must not include reserved result');
      expect(String(error)).toContain('ABORT');
    }
  });

  it('should reject unsupported nested workflow_call child return conditions during load', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'grandchild.yaml'), `name: grandchild
subworkflow:
  callable: true
  returns: [ok]
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: "Review"
    rules:
      - condition: done
        return: ok
`);
    writeFileSync(join(projectWorkflowsDir, 'child.yaml'), `name: child
subworkflow:
  callable: true
  returns: [ok]
initial_step: delegate-grandchild
max_steps: 3
steps:
  - name: delegate-grandchild
    kind: workflow_call
    call: grandchild
    rules:
      - condition: retry_plan
        next: COMPLETE
`);
    writeFileSync(join(projectWorkflowsDir, 'parent.yaml'), `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: ok
        next: COMPLETE
`);

    expect(() => loadWorkflowByIdentifier('parent', tempDir)).toThrow(
      'workflow_call step "delegate-grandchild" cannot route on unsupported child result "retry_plan"',
    );
  });

  it('should prefer project workflows over worktree workflows for named lookup', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    const worktreeDir = join(tempDir, '.takt', 'worktrees', 'feature-branch');
    const worktreeWorkflowsDir = join(worktreeDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    mkdirSync(worktreeWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'shared.yaml'), SAMPLE_WORKFLOW);
    writeFileSync(join(worktreeWorkflowsDir, 'shared.yaml'), `name: worktree-workflow
description: Worktree workflow
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: reviewer
    instruction: "{task}"
`);

    const workflow = loadWorkflowByIdentifier('shared', tempDir, { lookupCwd: worktreeDir });

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('test-workflow');
    expect(getWorkflowTrustInfo(workflow!, tempDir)).toMatchObject({
      source: 'project',
      isProjectTrustRoot: true,
      isProjectWorkflowRoot: true,
    });
  });

  it('should mark worktree workflow paths as worktree trust when lookupCwd points to a worktree', () => {
    const worktreeDir = join(tempDir, '.takt', 'worktrees', 'feature-branch');
    const worktreeWorkflowsDir = join(worktreeDir, '.takt', 'workflows');
    mkdirSync(worktreeWorkflowsDir, { recursive: true });
    writeFileSync(join(worktreeWorkflowsDir, 'shared.yaml'), `name: worktree-workflow
description: Worktree workflow
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: reviewer
    instruction: "{task}"
`);

    const workflow = loadWorkflowByIdentifier('./.takt/workflows/shared.yaml', tempDir, { lookupCwd: worktreeDir });

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('worktree-workflow');
    expect(getWorkflowTrustInfo(workflow!, tempDir)).toMatchObject({
      source: 'worktree',
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });
  });

  it('should classify privileged worktree-local workflow paths from the default external worktree root as worktree trust', () => {
    // 共有 tmp 直下の takt-worktrees を他テストファイルと共有するため一意化し、
    // tempDir の外に作る branch dir は自分で削除する（afterEach は tempDir のみ）。
    const worktreeDir = join(tempDir, '..', 'takt-worktrees', `feature-branch-${randomUUID()}`);
    try {
      const worktreeWorkflowsDir = join(worktreeDir, '.takt', 'workflows');
      mkdirSync(worktreeWorkflowsDir, { recursive: true });
      writeFileSync(join(worktreeWorkflowsDir, 'auto-improvement-loop.yaml'), `name: auto-improvement-loop
description: worktree system workflow
initial_step: route_context
max_steps: 2

steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - condition: "when(true)"
        next: COMPLETE
`);

      const workflow = loadWorkflowByIdentifier('./.takt/workflows/auto-improvement-loop.yaml', tempDir, { lookupCwd: worktreeDir });

      expect(workflow).not.toBeNull();
      expect(getWorkflowTrustInfo(workflow!, tempDir)).toMatchObject({
        source: 'worktree',
        isProjectTrustRoot: false,
        isProjectWorkflowRoot: false,
      });
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it('should load privileged project-local workflows by name', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'auto-improvement-loop.yaml'), `name: auto-improvement-loop
description: project system workflow
initial_step: route_context
max_steps: 2

steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - condition: "when(true)"
        next: COMPLETE
`);

    const workflow = loadWorkflowByIdentifier('auto-improvement-loop', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('auto-improvement-loop');
    expect(workflow!.steps[0]?.effects).toEqual([{ type: 'merge_pr', pr: 42 }]);
  });

  it('should load privileged global workflows by name and preserve user source identity', () => {
    const globalWorkflowsDir = join(process.env.TAKT_CONFIG_DIR!, 'workflows');
    mkdirSync(globalWorkflowsDir, { recursive: true });
    writeFileSync(join(globalWorkflowsDir, 'global-system.yaml'), `name: global-system
description: global system workflow
initial_step: route_context
max_steps: 2

steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - condition: "when(true)"
        next: COMPLETE
`);

    const workflow = loadWorkflowByIdentifier('global-system', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('global-system');
    expect(workflow!.steps[0]?.kind).toBe('system');
    expect(getWorkflowTrustInfo(workflow!, tempDir)).toMatchObject({
      source: 'user',
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });
  });

  it('should load builtin auto-improvement-loop by name and preserve builtin source identity', () => {
    const workflow = loadWorkflowByIdentifier('auto-improvement-loop', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('auto-improvement-loop');
    expect(getWorkflowTrustInfo(workflow!, tempDir)).toMatchObject({
      source: 'builtin',
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });
  });

  it('should load privileged project-local workflows loaded by path', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    const workflowPath = join(projectWorkflowsDir, 'auto-improvement-loop.yaml');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(workflowPath, `name: auto-improvement-loop
description: project system workflow
initial_step: route_context
max_steps: 2

steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - condition: "when(true)"
        next: COMPLETE
`);

    const workflow = loadWorkflowByIdentifier('./.takt/workflows/auto-improvement-loop.yaml', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('auto-improvement-loop');
    expect(workflow!.steps[0]?.effects).toEqual([{ type: 'merge_pr', pr: 42 }]);
  });

  it('should load workflow definitions that use steps and initial_step aliases', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'aliased-workflow.yaml'), `name: aliased-workflow
description: aliased workflow
initial_step: plan
max_steps: 1

steps:
  - name: plan
    persona: coder
    instruction: "{task}"
`);

    const workflow = loadWorkflowByIdentifier('aliased-workflow', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.initialStep).toBe('plan');
    expect(workflow!.steps).toHaveLength(1);
    expect(workflow!.steps[0]?.name).toBe('plan');
  });

  it('should load project-local workflow definitions from .takt/workflows', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'default.yaml'), `name: workflow-priority
description: workflow wins
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`);

    const workflow = loadWorkflowByIdentifier('default', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('workflow-priority');
  });
});

describe('public workflow loaders validate workflow_call contracts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
    setBuiltinWorkflowsEnabledForTest(false);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should reject unsupported workflow_call child return conditions through loadWorkflow', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    writeInvalidWorkflowCallContractFixture(projectWorkflowsDir);

    expect(() => loadWorkflow('parent', tempDir)).toThrow(
      'workflow_call step "delegate" cannot route on unsupported child result "retry_plan"',
    );
  });

  it('should reject unsupported parallel workflow_call child return conditions through public loaders', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    writeInvalidParallelWorkflowCallContractFixture(projectWorkflowsDir);

    const entriesWarning = vi.fn();
    const discoveryWithSourcesWarning = vi.fn();
    const discoveryWarning = vi.fn();

    expect(() => loadWorkflow('parent', tempDir)).toThrow(
      'workflow_call step "delegate" cannot route on unsupported child result "retry_plan"',
    );

    const entries = listWorkflowEntries(tempDir, { onWarning: entriesWarning });
    const workflowsWithSources = loadAllWorkflowDiscoveryWithSources(tempDir, {
      onWarning: discoveryWithSourcesWarning,
    });
    const workflows = loadAllWorkflowDiscovery(tempDir, { onWarning: discoveryWarning });

    expect(entries.find((entry) => entry.name === 'parent')).toBeUndefined();
    expect(entries.find((entry) => entry.name === 'child')).toBeDefined();
    expect(workflowsWithSources.has('parent')).toBe(false);
    expect(workflowsWithSources.has('child')).toBe(true);
    expect(workflows.has('parent')).toBe(false);
    expect(workflows.has('child')).toBe(true);
    expect(entriesWarning).toHaveBeenCalledWith(
      expect.stringContaining('workflow_call step "delegate" cannot route on unsupported child result "retry_plan"'),
    );
    expect(discoveryWithSourcesWarning).toHaveBeenCalledWith(
      expect.stringContaining('workflow_call step "delegate" cannot route on unsupported child result "retry_plan"'),
    );
    expect(discoveryWarning).toHaveBeenCalledWith(
      expect.stringContaining('workflow_call step "delegate" cannot route on unsupported child result "retry_plan"'),
    );
  });

  it('should warn and skip invalid workflow_call contracts from workflow entry discovery', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    writeInvalidWorkflowCallContractFixture(projectWorkflowsDir);

    const entriesWarning = vi.fn();

    const entries = listWorkflowEntries(tempDir, { onWarning: entriesWarning });

    expect(entries.find((entry) => entry.name === 'parent')).toBeUndefined();
    expect(entries.find((entry) => entry.name === 'child')).toBeDefined();
    expect(entriesWarning).toHaveBeenCalledWith(
      expect.stringContaining('workflow_call step "delegate" cannot route on unsupported child result "retry_plan"'),
    );
  });

  it('should warn and skip invalid workflow_call contracts from workflow discovery with sources', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    writeInvalidWorkflowCallContractFixture(projectWorkflowsDir);

    const workflowsWarning = vi.fn();

    const workflowsWithSources = loadAllWorkflowDiscoveryWithSources(tempDir, { onWarning: workflowsWarning });

    expect(workflowsWithSources.has('parent')).toBe(false);
    expect(workflowsWithSources.has('child')).toBe(true);
    expect(workflowsWarning).toHaveBeenCalledWith(
      expect.stringContaining('workflow_call step "delegate" cannot route on unsupported child result "retry_plan"'),
    );
  });

  it('should warn and skip invalid workflow_call contracts from workflow discovery config loader', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    writeInvalidWorkflowCallContractFixture(projectWorkflowsDir);

    const loadAllWarning = vi.fn();

    const workflows = loadAllWorkflowDiscovery(tempDir, { onWarning: loadAllWarning });

    expect(workflows.has('parent')).toBe(false);
    expect(workflows.has('child')).toBe(true);
    expect(loadAllWarning).toHaveBeenCalledWith(
      expect.stringContaining('workflow_call step "delegate" cannot route on unsupported child result "retry_plan"'),
    );
  });
});

describe('listWorkflows with project-local', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
    setBuiltinWorkflowsEnabledForTest(false);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should include project-local workflows when cwd is provided', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'project-custom.yaml'), SAMPLE_WORKFLOW);

    const workflows = listWorkflows(tempDir);
    expect(workflows).toContain('project-custom');
  });

  it('should include project-local workflows when cwd is provided', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'workflow-custom.yaml'), SAMPLE_WORKFLOW);

    const workflows = listWorkflows(tempDir);

    expect(workflows).toContain('workflow-custom');
  });

  it('should include builtin workflows regardless of cwd', () => {
    setBuiltinWorkflowsEnabledForTest(true);
    const workflows = listWorkflows(tempDir);
    expect(workflows).toContain('default');
  });

  it('should warn and skip invalid project-local workflows', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_WORKFLOW);
    const onWarning = vi.fn();

    const workflows = listWorkflows(tempDir, { onWarning });

    expect(workflows).not.toContain('broken');
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('broken'));
  });

  it('should include privileged project-local workflows', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'unsafe-system.yaml'), `name: unsafe-system
initial_step: route_context
max_steps: 1

steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - condition: "when(true)"
        next: COMPLETE
`);
    const onWarning = vi.fn();

    const workflows = listWorkflows(tempDir, { onWarning });

    expect(workflows).toContain('unsafe-system');
    expect(onWarning).not.toHaveBeenCalled();
  });

});

describe('internal callable workflow visibility', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
    setBuiltinWorkflowsEnabledForTest(false);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writePublicCallableWorkflow(): void {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'public-callable.yaml'), `name: public-callable
subworkflow:
  callable: true
  params:
    review_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
initial_step: review
max_steps: 1
steps:
  - name: review
    knowledge:
      $param: review_knowledge
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
  }

  const publicCallableDiscoveryConfig = {
    name: 'public-callable',
    subworkflow: {
      callable: true,
      visibility: undefined,
      returns: undefined,
      params: {
        review_knowledge: {
          type: 'facet_ref[]',
          facetKind: 'knowledge',
          default: undefined,
        },
      },
    },
  };

  it('should hide visibility: internal workflows from discovery APIs', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'public-parent.yaml'), `name: public-parent
initial_step: review
max_steps: 1

steps:
  - name: review
    persona: reviewer
    instruction: "Review publicly"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeFileSync(join(projectWorkflowsDir, 'internal-review.yaml'), `name: internal-review
subworkflow:
  callable: true
  visibility: internal
  params:
    review_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
initial_step: review
max_steps: 1

steps:
  - name: review
    knowledge:
      $param: review_knowledge
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const discoveryWarning = vi.fn();
    const runtimeWithSourcesWarning = vi.fn();
    const runtimeWarning = vi.fn();
    const entries = listWorkflowEntries(tempDir, { onWarning: discoveryWarning });
    const workflowNames = listWorkflows(tempDir, { onWarning: discoveryWarning });
    const discoveryWithSources = loadAllWorkflowDiscoveryWithSources(tempDir, { onWarning: discoveryWarning });
    const workflowsWithSources = loadAllWorkflowsWithSources(tempDir, { onWarning: runtimeWithSourcesWarning });
    const workflows = loadAllWorkflows(tempDir, { onWarning: runtimeWarning });

    expect(entries.map((entry) => entry.name)).toContain('public-parent');
    expect(entries.map((entry) => entry.name)).not.toContain('internal-review');
    expect(workflowNames).toContain('public-parent');
    expect(workflowNames).not.toContain('internal-review');
    expect(discoveryWithSources.has('public-parent')).toBe(true);
    expect(discoveryWithSources.has('internal-review')).toBe(false);
    expect(workflowsWithSources.has('public-parent')).toBe(true);
    expect(workflowsWithSources.has('internal-review')).toBe(false);
    expect(workflows.has('internal-review')).toBe(false);
    expect(discoveryWarning).not.toHaveBeenCalled();
    expect(runtimeWithSourcesWarning).not.toHaveBeenCalled();
    expect(runtimeWarning).not.toHaveBeenCalled();
  }, 30_000);

  it('should keep public callable workflows with required params visible in discovery APIs', () => {
    writePublicCallableWorkflow();
    const discoveryWarning = vi.fn();
    const entries = listWorkflowEntries(tempDir, { onWarning: discoveryWarning });
    const workflowNames = listWorkflows(tempDir, { onWarning: discoveryWarning });
    const discoveryWithSources = loadAllWorkflowDiscoveryWithSources(tempDir, { onWarning: discoveryWarning });
    const discovery = loadAllWorkflowDiscovery(tempDir, { onWarning: discoveryWarning });

    expect(entries.map((entry) => entry.name)).toContain('public-callable');
    expect(workflowNames).toContain('public-callable');
    expect(discoveryWithSources.has('public-callable')).toBe(true);
    expect(discovery.has('public-callable')).toBe(true);
    expect(discoveryWithSources.get('public-callable')?.config).toEqual(publicCallableDiscoveryConfig);
    expect(discovery.get('public-callable')).toEqual(publicCallableDiscoveryConfig);
    expect(discoveryWarning).not.toHaveBeenCalled();
  }, 30_000);

  it('should hide public callable workflows with required params from standalone loaders', () => {
    writePublicCallableWorkflow();
    const standaloneWarning = vi.fn();
    const standaloneEntries = listStandaloneWorkflowEntries(tempDir, { onWarning: standaloneWarning });
    const standaloneWithSources = loadAllStandaloneWorkflowsWithSources(tempDir, { onWarning: standaloneWarning });
    const standalone = loadAllStandaloneWorkflows(tempDir, { onWarning: standaloneWarning });

    expect(standaloneEntries.map((entry) => entry.name)).not.toContain('public-callable');
    expect(standaloneWithSources.has('public-callable')).toBe(false);
    expect(standalone.has('public-callable')).toBe(false);
    expect(standaloneWarning).toHaveBeenCalledWith(
      expect.stringContaining('requires workflow_call arg "review_knowledge"'),
    );
  }, 30_000);

  it('should hide public callable workflows with required params from runtime loaders', () => {
    writePublicCallableWorkflow();
    const runtimeWithSourcesWarning = vi.fn();
    const runtimeWarning = vi.fn();
    const workflowsWithSources = loadAllWorkflowsWithSources(tempDir, { onWarning: runtimeWithSourcesWarning });
    const workflows = loadAllWorkflows(tempDir, { onWarning: runtimeWarning });

    expect(workflowsWithSources.has('public-callable')).toBe(false);
    expect(workflows.has('public-callable')).toBe(false);
    expect(() => loadWorkflowByIdentifier('public-callable', tempDir)).toThrow(
      /requires workflow_call arg "review_knowledge"/,
    );
    expect(runtimeWithSourcesWarning).toHaveBeenCalledWith(
      expect.stringContaining('requires workflow_call arg "review_knowledge"'),
    );
    expect(runtimeWarning).toHaveBeenCalledWith(
      expect.stringContaining('requires workflow_call arg "review_knowledge"'),
    );
  }, 30_000);

  it('should validate path-based workflow_call children only in runtime batch loaders', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'child.yaml'), `name: child
subworkflow:
  callable: true
  returns: [ok]
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: "Review"
    rules:
      - condition: done
        return: ok
`, 'utf-8');
    writeFileSync(join(projectWorkflowsDir, 'parent.yaml'), `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ./child.yaml
    rules:
      - condition: retry_plan
        next: COMPLETE
`, 'utf-8');

    const entriesWarning = vi.fn();
    const discoveryWarning = vi.fn();
    const runtimeWithSourcesWarning = vi.fn();
    const runtimeWarning = vi.fn();

    const entries = listWorkflowEntries(tempDir, { onWarning: entriesWarning });
    const discoveryWithSources = loadAllWorkflowDiscoveryWithSources(tempDir, { onWarning: discoveryWarning });
    const discovery = loadAllWorkflowDiscovery(tempDir, { onWarning: discoveryWarning });
    const workflowsWithSources = loadAllWorkflowsWithSources(tempDir, { onWarning: runtimeWithSourcesWarning });
    const workflows = loadAllWorkflows(tempDir, { onWarning: runtimeWarning });

    expect(entries.map((entry) => entry.name)).toContain('parent');
    expect(discoveryWithSources.get('parent')?.config).toEqual({
      name: 'parent',
      description: undefined,
      subworkflow: undefined,
    });
    expect(discovery.get('parent')).toEqual({
      name: 'parent',
      description: undefined,
      subworkflow: undefined,
    });
    expect(workflowsWithSources.has('parent')).toBe(false);
    expect(workflows.has('parent')).toBe(false);
    expect(entriesWarning).not.toHaveBeenCalled();
    expect(discoveryWarning).not.toHaveBeenCalled();
    expect(runtimeWithSourcesWarning).toHaveBeenCalledWith(
      expect.stringContaining('workflow_call step "delegate" cannot route on unsupported child result "retry_plan"'),
    );
    expect(runtimeWarning).toHaveBeenCalledWith(
      expect.stringContaining('workflow_call step "delegate" cannot route on unsupported child result "retry_plan"'),
    );
  }, 30_000);

  it('should still load visibility: internal workflows by explicit identifier', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'internal-review.yaml'), `name: internal-review
subworkflow:
  callable: true
  visibility: internal
initial_step: review
max_steps: 1

steps:
  - name: review
    persona: reviewer
    instruction: "Review internally"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const workflow = loadWorkflowByIdentifier('internal-review', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('internal-review');
    expect((workflow!.subworkflow as Record<string, unknown>)?.visibility).toBe('internal');
  });

  it('should warn when visibility: internal is declared without callable: true', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'broken-internal.yaml'), `name: broken-internal
subworkflow:
  visibility: internal
initial_step: review
max_steps: 1

steps:
  - name: review
    persona: reviewer
    instruction: "Review internally"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const onWarning = vi.fn();
    const workflowNames = listWorkflows(tempDir, { onWarning });

    expect(workflowNames).not.toContain('broken-internal');
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('broken-internal'));
  });
});

describe('loadAllWorkflows with project-local', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
    setBuiltinWorkflowsEnabledForTest(false);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should include project-local workflows when cwd is provided', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'project-custom.yaml'), SAMPLE_WORKFLOW);

    const workflows = loadAllWorkflows(tempDir);
    expect(workflows.has('project-custom')).toBe(true);
    expect(workflows.get('project-custom')!.name).toBe('test-workflow');
  });

  it('should have project-local override builtin when same name', () => {
    setBuiltinWorkflowsEnabledForTest(true);
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });

    const overrideWorkflow = `name: project-override
description: Project override
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`;
    writeFileSync(join(projectWorkflowsDir, 'default.yaml'), overrideWorkflow);

    const workflows = loadAllWorkflows(tempDir);
    expect(workflows.get('default')!.name).toBe('project-override');
  });

  it('should load project-local workflows in loadAllWorkflows', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'shared.yaml'), `name: workflow-priority
description: workflow priority
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`);

    const workflows = loadAllWorkflows(tempDir);

    expect(workflows.get('shared')?.name).toBe('workflow-priority');
  });

  it('should load privileged project-local workflows in loadAllWorkflows', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'unsafe-system.yaml'), `name: unsafe-system
initial_step: route_context
max_steps: 1

steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - condition: "when(true)"
        next: COMPLETE
`);
    const onWarning = vi.fn();

    const workflows = loadAllWorkflows(tempDir, { onWarning });

    expect(workflows.has('unsafe-system')).toBe(true);
    expect(workflows.get('unsafe-system')).toMatchObject({
      name: 'unsafe-system',
      initialStep: 'route_context',
      maxSteps: 1,
      steps: [
        {
          name: 'route_context',
          kind: 'system',
          effects: [
            {
              type: 'merge_pr',
              pr: 42,
            },
          ],
        },
      ],
    });
    expect(onWarning).not.toHaveBeenCalled();
  });

});

describe('loadWorkflowByIdentifier with @scope ref (repertoire)', () => {
  let tempDir: string;
  let configDir: string;
  const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
    configDir = mkdtempSync(join(tmpdir(), 'takt-config-'));
    process.env.TAKT_CONFIG_DIR = configDir;
    setBuiltinWorkflowsEnabledForTest(false);
  });

  afterEach(() => {
    if (originalTaktConfigDir !== undefined) {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    } else {
      delete process.env.TAKT_CONFIG_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('should load workflow by @scope ref (repertoire)', () => {
    const workflowsDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'expert.yaml'), SAMPLE_WORKFLOW);

    const workflow = loadWorkflowByIdentifier('@nrslib/takt-ensemble/expert', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('test-workflow');
  });

  it('should return null for non-existent @scope workflow', () => {
    const workflowsDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    const workflow = loadWorkflowByIdentifier('@nrslib/takt-ensemble/no-such-workflow', tempDir);

    expect(workflow).toBeNull();
  });

  it('should reject callable section map package parent symlinks before expanding workflow_call defaults', () => {
    const ownerDir = join(configDir, 'repertoire', '@nrslib');
    const packageLink = join(ownerDir, 'pkg');
    const outsidePackageDir = join(tempDir, 'outside-package');
    const workflowsDir = join(outsidePackageDir, 'workflows');
    const instructionsDir = join(outsidePackageDir, 'facets', 'instructions');
    mkdirSync(ownerDir, { recursive: true });
    mkdirSync(workflowsDir, { recursive: true });
    mkdirSync(instructionsDir, { recursive: true });
    writeFileSync(join(instructionsDir, 'linked.md'), 'Secret instruction', 'utf-8');
    writeFileSync(join(workflowsDir, 'child.yaml'), `name: child
subworkflow:
  callable: true
  params:
    review_instruction:
      type: facet_ref
      facet_kind: instruction
      default: linked
max_steps: 1
initial_step: review
instructions:
  linked: ../facets/instructions/linked.md
steps:
  - name: review
    instruction:
      $param: review_instruction
`);
    symlinkSync(outsidePackageDir, packageLink, 'dir');

    expect(() => loadWorkflowByIdentifier('@nrslib/pkg/child', tempDir)).toThrow(
      /Scoped facet file must stay inside the repertoire and must not use symlinks/,
    );
  });
});

describe('loadAllWorkflowsWithSources with repertoire workflows', () => {
  let tempDir: string;
  let configDir: string;
  const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
    configDir = mkdtempSync(join(tmpdir(), 'takt-config-'));
    process.env.TAKT_CONFIG_DIR = configDir;
    setBuiltinWorkflowsEnabledForTest(false);
  });

  afterEach(() => {
    if (originalTaktConfigDir !== undefined) {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    } else {
      delete process.env.TAKT_CONFIG_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('should include repertoire workflows with @scope qualified names', () => {
    const workflowsDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'expert.yaml'), SAMPLE_WORKFLOW);

    const workflows = loadAllWorkflowsWithSources(tempDir);

    expect(workflows.has('@nrslib/takt-ensemble/expert')).toBe(true);
    expect(workflows.get('@nrslib/takt-ensemble/expert')!.source).toBe('repertoire');
  });

  it('should not throw when repertoire dir does not exist', () => {
    const workflows = loadAllWorkflowsWithSources(tempDir);

    const repertoireWorkflows = Array.from(workflows.keys()).filter((k) => k.startsWith('@'));
    expect(repertoireWorkflows).toHaveLength(0);
  });

  it('should warn and skip invalid project-local workflows', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_WORKFLOW);
    const onWarning = vi.fn();

    const workflows = loadAllWorkflowsWithSources(tempDir, { onWarning });

    expect(workflows.has('broken')).toBe(false);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('broken'));
  });

  it('should warn and skip invalid repertoire workflows', () => {
    const workflowsDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_WORKFLOW);
    const onWarning = vi.fn();

    const workflows = loadAllWorkflowsWithSources(tempDir, { onWarning });

    expect(workflows.has('@nrslib/takt-ensemble/broken')).toBe(false);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('@nrslib/takt-ensemble/broken'));
  });

  it('should forward warnings through loadAllWorkflows callback', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_WORKFLOW);
    const onWarning = vi.fn();

    const workflows = loadAllWorkflows(tempDir, { onWarning });

    expect(workflows.has('broken')).toBe(false);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('allowed_tools'));
  });

  it('should return workflow entries from .takt/workflows in loadAllWorkflowsWithSources and listWorkflowEntries', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'shared.yaml'), `name: workflow-priority
description: workflow priority
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`);

    const workflows = loadAllWorkflowsWithSources(tempDir);
    const entries = listWorkflowEntries(tempDir);

    expect(workflows.get('shared')?.config.name).toBe('workflow-priority');
    expect(entries.find((entry) => entry.name === 'shared')?.path).toBe(
      join(projectWorkflowsDir, 'shared.yaml'),
    );
  });

  it('should load user workflows for the same name', () => {
    const userWorkflowsDir = join(configDir, 'workflows');
    mkdirSync(userWorkflowsDir, { recursive: true });
    writeFileSync(join(userWorkflowsDir, 'shared.yaml'), `name: user-workflow
description: user workflow priority
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`);

    const workflow = loadWorkflowByIdentifier('shared', tempDir);
    const workflows = loadAllWorkflowsWithSources(tempDir);
    const entries = listWorkflowEntries(tempDir);

    expect(workflow?.name).toBe('user-workflow');
    expect(workflows.get('shared')?.config.name).toBe('user-workflow');
    expect(entries.find((entry) => entry.name === 'shared')?.path).toBe(
      join(userWorkflowsDir, 'shared.yaml'),
    );
  });

  it('should prefer project workflows over user workflows', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    const userWorkflowsDir = join(configDir, 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    mkdirSync(userWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'shared.yaml'), `name: project-workflow
description: project workflow priority
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`);
    writeFileSync(join(userWorkflowsDir, 'shared.yaml'), `name: user-workflow
description: user workflow priority
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`);

    const workflow = loadWorkflowByIdentifier('shared', tempDir);
    const workflows = loadAllWorkflowsWithSources(tempDir);
    const entries = listWorkflowEntries(tempDir);

    expect(workflow?.name).toBe('project-workflow');
    expect(workflows.get('shared')?.config.name).toBe('project-workflow');
    expect(entries.find((entry) => entry.name === 'shared')?.path).toBe(
      join(projectWorkflowsDir, 'shared.yaml'),
    );
  });

  it('should reject conflicting workflow aliases', () => {
    const conflictPath = join(tempDir, 'conflict.yaml');
    writeFileSync(conflictPath, `name: conflict
description: conflicting aliases
initial_step: plan
max_steps: 1

steps:
  - name: plan
    persona: coder
    instruction: "{task}"
steps:
  - name: implement
    persona: coder
    instruction: "{task}"
`);

    expect(() => loadWorkflowByIdentifier(conflictPath, tempDir)).toThrow(
      /Map keys must be unique|duplicated mapping key/i,
    );
  });

  it('should return validated selection entries for repertoire workflows without collapsing repo names', () => {
    const workflowsDirA = join(configDir, 'repertoire', '@nrslib', 'repo-a', 'workflows');
    const workflowsDirB = join(configDir, 'repertoire', '@nrslib', 'repo-b', 'workflows');
    mkdirSync(workflowsDirA, { recursive: true });
    mkdirSync(workflowsDirB, { recursive: true });
    writeFileSync(join(workflowsDirA, 'expert.yaml'), SAMPLE_WORKFLOW);
    writeFileSync(join(workflowsDirB, 'expert.yaml'), SAMPLE_WORKFLOW);

    const entries = listWorkflowEntries(tempDir);

    expect(entries).toEqual(
      expect.arrayContaining([
        {
          name: '@nrslib/repo-a/expert',
          path: join(workflowsDirA, 'expert.yaml'),
          source: 'repertoire',
        },
        {
          name: '@nrslib/repo-b/expert',
          path: join(workflowsDirB, 'expert.yaml'),
          source: 'repertoire',
        },
      ]),
    );
  });

  it('should warn and skip invalid entries from listWorkflowEntries', () => {
    const workflowsDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_WORKFLOW);
    const onWarning = vi.fn();

    const entries = listWorkflowEntries(tempDir, { onWarning });

    expect(entries.find((entry) => entry.name === '@nrslib/takt-ensemble/broken')).toBeUndefined();
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('@nrslib/takt-ensemble/broken'));
  });
});

describe('normalizeArpeggio: strategy coercion via loadWorkflowByIdentifier', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-arpeggio-coerce-'));
    mkdirSync(join(tempDir, '.takt'), { recursive: true });
    // Dummy files required by normalizeArpeggio (resolved relative to workflow dir)
    writeFileSync(join(tempDir, 'template.md'), '{line:1}');
    writeFileSync(join(tempDir, 'data.csv'), 'col\nval');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should preserve strategy:"custom" when loading arpeggio workflow YAML', () => {
    writeFileSync(
      join(tempDir, '.takt', 'config.yaml'),
      ['workflow_arpeggio:', '  custom_merge_inline_js: true'].join('\n'),
      'utf-8',
    );

    const workflowYaml = `name: arpeggio-coerce-test
initial_step: process
max_steps: 5
steps:
  - name: process
    persona: coder
    arpeggio:
      source: csv
      source_path: ./data.csv
      template: ./template.md
      merge:
        strategy: custom
        inline_js: 'return results.map(r => r.content).join(", ");'
    rules:
      - condition: All processed
        next: COMPLETE
`;
    const workflowPath = join(tempDir, 'workflow.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const config = loadWorkflowByIdentifier(workflowPath, tempDir);

    expect(config).not.toBeNull();
    const step = config!.steps[0]!;
    expect(step.arpeggio).toBeDefined();
    expect(step.arpeggio!.merge.strategy).toBe('custom');
    expect(step.arpeggio!.merge.inlineJs).toContain('map');
  });

  it('should preserve concat strategy and separator when loading arpeggio workflow YAML', () => {
    const workflowYaml = `name: arpeggio-concat-test
initial_step: process
max_steps: 5
steps:
  - name: process
    persona: coder
    arpeggio:
      source: csv
      source_path: ./data.csv
      template: ./template.md
      merge:
        strategy: concat
        separator: "\\n---\\n"
    rules:
      - condition: All processed
        next: COMPLETE
`;
    const workflowPath = join(tempDir, 'workflow.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const config = loadWorkflowByIdentifier(workflowPath, tempDir);

    expect(config).not.toBeNull();
    const step = config!.steps[0]!;
    expect(step.arpeggio!.merge.strategy).toBe('concat');
    expect(step.arpeggio!.merge.separator).toBe('\n---\n');
  });
});

describe('Workflow Maker artifact isolation', () => {
  const fixedTime = new Date(2026, 0, 2, 3, 4, 5, 6);
  let projectDir: string;
  let configDir: string;
  let previousConfigDir: string | undefined;
  const repositoryFixturePaths: string[] = [];

  function writeFixture(relativePath: string, content: string): string {
    const filePath = join(projectDir, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  function writeConfigFixture(relativePath: string, content: string): string {
    const filePath = join(configDir, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  function listFiles(root: string, base = root): string[] {
    if (!existsSync(root)) {
      return [];
    }
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = join(root, entry.name);
      return entry.isDirectory()
        ? listFiles(entryPath, base)
        : [relative(base, entryPath)];
    });
  }

  function existingBase(
    path: string,
    name: string,
    source: 'project' | 'user' | 'builtin' | 'repertoire',
  ) {
    return {
      kind: 'existing' as const,
      workflow: { name, path, source },
    };
  }

  beforeEach(() => {
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    projectDir = mkdtempSync(join(tmpdir(), 'takt-maker-project-'));
    configDir = mkdtempSync(join(tmpdir(), 'takt-maker-config-'));
    process.env.TAKT_CONFIG_DIR = configDir;
    writeFileSync(join(configDir, 'config.yaml'), [
      'enable_builtin_workflows: false',
      'workflow_arpeggio:',
      '  custom_merge_files: true',
      '',
    ].join('\n'), 'utf-8');
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    for (const fixturePath of repositoryFixturePaths.splice(0)) {
      rmSync(fixturePath, { force: true });
    }
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
    invalidateGlobalConfigCache();
  });

  it.each(['project', 'user', 'builtin', 'repertoire'] as const)(
    'copies a %s workflow as an independently loadable root',
    async (source) => {
      const fixtureId = randomUUID();
      const name = `${source}-base-${fixtureId}`;
      const personaName = `${source}-persona-${fixtureId}`;
      const companionName = `${source}-companion-${fixtureId}`;
      const capabilityName = `${source}-capability-${fixtureId}`;
      let rootPath: string;
      let personaPath: string;
      let companionInstructionPath: string;
      let companionPath: string;
      let capabilityPath: string;
      let assetPaths: [string, string, string];
      const workflow = `name: ${name}
description: ${companionName}, ${capabilityName}, and @unused/pkg/facet are copied only from reference fields.
capabilities: ${capabilityName}
initial_step: create
max_steps: 2
steps:
  - name: create
    persona: ${personaName}
    companion: [${companionName}]
    instruction: Create this workflow directly.
    rules:
      - condition: done
        next: batch
  - name: batch
    instruction: Process the generated inputs.
    arpeggio:
      source: csv
      source_path: ../assets/${name}.csv
      template: ../assets/${name}.md
      merge:
        strategy: custom
        file: ../assets/${name}.cjs
`;
      if (source === 'project') {
        rootPath = writeFixture(`.takt/workflows/${name}.yaml`, workflow);
        personaPath = writeFixture(`.takt/facets/personas/${personaName}.md`, '# project persona\n');
        companionInstructionPath = writeFixture(`.takt/facets/instructions/${personaName}.md`, 'Review the project workflow.\n');
        companionPath = writeFixture(`.takt/companions/${companionName}.yaml`, `name: ${companionName}
description: Project companion
instruction: ${personaName}
`);
        capabilityPath = writeFixture(`.takt/provider-options/${capabilityName}.yaml`, 'codex:\n  network_access: true\n');
        assetPaths = [
          writeFixture(`.takt/assets/${name}.csv`, 'value\nproject\n'),
          writeFixture(`.takt/assets/${name}.md`, 'Process project {value}.\n'),
          writeFixture(`.takt/assets/${name}.cjs`, 'export default (items) => items.join("\\n");\n'),
        ];
      } else if (source === 'user') {
        rootPath = writeConfigFixture(`workflows/${name}.yaml`, workflow);
        personaPath = writeConfigFixture(`facets/personas/${personaName}.md`, '# global persona\n');
        companionInstructionPath = writeConfigFixture(`facets/instructions/${personaName}.md`, 'Review the global workflow.\n');
        companionPath = writeConfigFixture(`companions/${companionName}.yaml`, `name: ${companionName}
description: Global companion
instruction: ${personaName}
`);
        capabilityPath = writeConfigFixture(`provider-options/${capabilityName}.yaml`, 'codex:\n  network_access: true\n');
        assetPaths = [
          writeConfigFixture(`assets/${name}.csv`, 'value\nglobal\n'),
          writeConfigFixture(`assets/${name}.md`, 'Process global {value}.\n'),
          writeConfigFixture(`assets/${name}.cjs`, 'export default (items) => items.join("\\n");\n'),
        ];
      } else if (source === 'builtin') {
        rootPath = join(process.cwd(), 'builtins', 'en', 'workflows', `${name}.yaml`);
        personaPath = join(process.cwd(), 'builtins', 'en', 'facets', 'personas', `${personaName}.md`);
        companionInstructionPath = join(process.cwd(), 'builtins', 'en', 'facets', 'instructions', `${personaName}.md`);
        companionPath = join(process.cwd(), 'builtins', 'en', 'companions', `${companionName}.yaml`);
        capabilityPath = join(process.cwd(), 'builtins', 'en', 'provider-options', `${capabilityName}.yaml`);
        assetPaths = [
          join(process.cwd(), 'builtins', 'en', 'assets', `${name}.csv`),
          join(process.cwd(), 'builtins', 'en', 'assets', `${name}.md`),
          join(process.cwd(), 'builtins', 'en', 'assets', `${name}.cjs`),
        ];
        mkdirSync(dirname(personaPath), { recursive: true });
        mkdirSync(dirname(companionInstructionPath), { recursive: true });
        mkdirSync(dirname(companionPath), { recursive: true });
        mkdirSync(dirname(capabilityPath), { recursive: true });
        mkdirSync(dirname(assetPaths[0]), { recursive: true });
        writeFileSync(rootPath, workflow, 'utf-8');
        writeFileSync(personaPath, '# builtin persona\n', 'utf-8');
        writeFileSync(companionInstructionPath, 'Review the builtin workflow.\n', 'utf-8');
        writeFileSync(companionPath, `name: ${companionName}
description: Builtin companion
instruction: ${personaName}
`, 'utf-8');
        writeFileSync(capabilityPath, 'codex:\n  network_access: true\n', 'utf-8');
        writeFileSync(assetPaths[0], 'value\nbuiltin\n', 'utf-8');
        writeFileSync(assetPaths[1], 'Process builtin {value}.\n', 'utf-8');
        writeFileSync(assetPaths[2], 'export default (items) => items.join("\\n");\n', 'utf-8');
        repositoryFixturePaths.push(
          rootPath,
          personaPath,
          companionInstructionPath,
          companionPath,
          capabilityPath,
          ...assetPaths,
        );
      } else {
        rootPath = writeConfigFixture(
          `repertoire/@owner/pkg/workflows/${name}.yaml`,
          workflow,
        );
        personaPath = writeConfigFixture(
          `repertoire/@owner/pkg/facets/personas/${personaName}.md`,
          '# repertoire persona\n',
        );
        companionInstructionPath = writeConfigFixture(
          `repertoire/@owner/pkg/facets/instructions/${personaName}.md`,
          'Review the repertoire workflow.\n',
        );
        companionPath = writeFixture(`.takt/companions/${companionName}.yaml`, `name: ${companionName}
description: Repertoire workflow companion
instruction: "@owner/pkg/${personaName}"
`);
        capabilityPath = writeConfigFixture(
          `repertoire/@owner/pkg/provider-options/${capabilityName}.yaml`,
          'codex:\n  network_access: true\n',
        );
        assetPaths = [
          writeConfigFixture(`repertoire/@owner/pkg/assets/${name}.csv`, 'value\nrepertoire\n'),
          writeConfigFixture(`repertoire/@owner/pkg/assets/${name}.md`, 'Process repertoire {value}.\n'),
          writeConfigFixture(`repertoire/@owner/pkg/assets/${name}.cjs`, 'export default (items) => items.join("\\n");\n'),
        ];
      }

      const originalContents = new Map(
        [
          rootPath,
          personaPath,
          companionInstructionPath,
          companionPath,
          capabilityPath,
          ...assetPaths,
        ].map((path) => [path, readFileSync(path, 'utf-8')]),
      );

      const plan = await planWorkflowMakerArtifact({
        projectDir,
        base: existingBase(rootPath, name, source),
        now: () => fixedTime,
      });
      await materializeWorkflowMakerArtifact(plan);

      const copiedRoot = join(plan.artifactRoot, 'workflows', `${name}.yaml`);
      expect(existsSync(copiedRoot)).toBe(true);
      expect(parseYaml(readFileSync(copiedRoot, 'utf-8'))).toEqual(
        expect.objectContaining({ name }),
      );
      expect(existsSync(join(plan.artifactRoot, 'facets', 'personas', `${personaName}.md`))).toBe(true);
      expect(existsSync(join(plan.artifactRoot, 'companions', `${companionName}.yaml`))).toBe(true);
      expect(existsSync(join(plan.artifactRoot, 'provider-options', `${capabilityName}.yaml`))).toBe(true);
      expect(assetPaths.every((path) => existsSync(join(plan.artifactRoot, 'assets', basename(path))))).toBe(true);
      for (const [path, content] of originalContents) {
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, 'utf-8')).toBe(content);
      }
      rmSync(rootPath, { force: true });
      rmSync(personaPath, { force: true });
      rmSync(companionInstructionPath, { force: true });
      rmSync(companionPath, { force: true });
      rmSync(capabilityPath, { force: true });
      for (const assetPath of assetPaths) rmSync(assetPath, { force: true });
      const loaded = loadWorkflowFromFile(copiedRoot, projectDir, {
        resourceRoot: plan.artifactRoot,
      });
      expect(findAgentWorkflowStep(loaded, 'create').capabilityProviderOptions?.codex?.networkAccess).toBe(true);
      expect(loaded.companions?.[companionName]?.instruction).toContain('workflow');
      const prepared = prepareWorkflowExecutionBundle({
        rootWorkflow: loaded,
        workflowCallResolver: () => null,
        projectCwd: projectDir,
        lookupCwd: plan.artifactRoot,
      });
      expect([...prepared.resources.values()].map((content) => content.toString('utf-8'))).toEqual(
        expect.arrayContaining([expect.stringMatching(/^value\n/), expect.stringContaining('Process ')]),
      );
    },
  );

  it('preserves an existing workflow filename independently from its YAML name', async () => {
    const rootPath = writeFixture('.takt/workflows/base-file.yaml', `name: base-name
initial_step: plan
max_steps: 1
steps:
  - name: plan
    instruction: Plan
`);

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'base-file', 'project'),
      now: () => fixedTime,
    });
    expect(plan.rootWorkflowPath).toBe(join(plan.artifactRoot, 'workflows', 'base-file.yaml'));
    expect(plan.workflowName).toBe('base-file');
    const plannedRoot = plan.files.find((file) => file.relativePath === join('workflows', 'base-file.yaml'));
    expect(parseYaml(plannedRoot?.content ?? '')).toEqual(expect.objectContaining({ name: 'base-name' }));

    await materializeWorkflowMakerArtifact(plan);
    rmSync(rootPath);
    const loaded = loadWorkflowFromFile(plan.rootWorkflowPath, projectDir, {
      resourceRoot: plan.artifactRoot,
    });
    expect(loaded.name).toBe('base-name');
    expect(findAgentWorkflowStep(loaded, 'plan').instruction).toBe('Plan');
  });

  it('copies output order facets independently of parameterized formats and preserves order classification', async () => {
    const rootPath = writeFixture('.takt/workflows/output-order.yaml', `name: output-order
report_formats:
  format-source: ../facets/output-contracts/format-source.md
  local-order: ../facets/output-contracts/local-order.md
initial_step: report
max_steps: 1
steps:
  - uses: ordered-report
    with:
      report_format: format-source
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFixture('.takt/steps/ordered-report.yaml', `params:
  report_format:
    type: facet_ref
    facet_kind: report_format
name: report
instruction: Create the reports directly.
output_contracts:
  report:
    - name: external.md
      format:
        $param: report_format
      order: custom-report-order
    - name: local.md
      format:
        $param: report_format
      order: local-order
    - name: inline.md
      format:
        $param: report_format
      order: Write sections in this exact order.
`);
    writeFixture('.takt/facets/output-contracts/format-source.md', 'FORMAT_MARKER\n');
    writeFixture('.takt/facets/output-contracts/local-order.md', 'LOCAL_ORDER_MARKER\n');
    writeFixture('.takt/facets/output-contracts/custom-report-order.md', 'EXTERNAL_ORDER_MARKER\n');

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'output-order', 'project'),
      now: () => fixedTime,
    });
    const copiedFragment = parseYaml(plan.files.find(
      (file) => file.relativePath === join('steps', 'ordered-report.yaml'),
    )?.content ?? '') as {
      output_contracts?: { report?: Array<{ format?: unknown; order?: string }> };
    };
    expect(copiedFragment.output_contracts?.report?.map((report) => report.order)).toEqual([
      '../facets/output-contracts/custom-report-order.md',
      'local-order',
      'Write sections in this exact order.',
    ]);
    expect(copiedFragment.output_contracts?.report?.[0]?.format).toEqual({ $param: 'report_format' });
    await materializeWorkflowMakerArtifact(plan);

    rmSync(join(projectDir, '.takt', 'workflows'), { recursive: true, force: true });
    rmSync(join(projectDir, '.takt', 'steps'), { recursive: true, force: true });
    rmSync(join(projectDir, '.takt', 'facets'), { recursive: true, force: true });
    const loaded = loadWorkflowFromFile(plan.rootWorkflowPath, projectDir, {
      resourceRoot: plan.artifactRoot,
    });
    const reportStep = findAgentWorkflowStep(loaded, 'report');
    expect(reportStep.outputContracts?.map((contract) => contract.order)).toEqual([
      'EXTERNAL_ORDER_MARKER\n',
      'LOCAL_ORDER_MARKER\n',
      'Write sections in this exact order.',
    ]);
    expect(new ReportInstructionBuilder(reportStep, {
      cwd: plan.artifactRoot,
      reportDir: join(plan.artifactRoot, 'reports'),
      stepIteration: 1,
      targetFile: 'external.md',
    }).build()).toContain('EXTERNAL_ORDER_MARKER');
  });

  it('rejects an unresolved output order before writing', async () => {
    const rootPath = writeFixture('.takt/workflows/missing-output-order.yaml', `name: missing-output-order
initial_step: report
max_steps: 1
steps:
  - name: report
    instruction: Create the report directly.
    output_contracts:
      report:
        - name: report.md
          format: Write the report directly.
          order: missing-report-order
`);

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'missing-output-order', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/missing-report-order/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('keeps colliding Arpeggio asset names distinct and deduplicates repeated canonical assets', async () => {
    const rootPath = writeFixture('.takt/workflows/arpeggio-assets.yaml', `name: arpeggio-assets
description: custom-report-order and ../../rows.csv are examples only
initial_step: first
max_steps: 3
steps:
  - name: first
    instruction: Process the first source.
    arpeggio:
      source: csv
      source_path: ../assets/first/input.dat
      template: ../assets/prompt.md
  - name: second
    instruction: Process the second source.
    arpeggio:
      source: csv
      source_path: ../assets/second/input.dat
      template: ../assets/prompt.md
  - name: repeated
    instruction: Process the first source again.
    arpeggio:
      source: csv
      source_path: ../assets/first/input.dat
      template: ../assets/prompt.md
`);
    writeFixture('.takt/assets/first/input.dat', 'FIRST_INPUT\n');
    writeFixture('.takt/assets/second/input.dat', 'SECOND_INPUT\n');
    writeFixture('.takt/assets/prompt.md', 'Process {value}.\n');

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'arpeggio-assets', 'project'),
      now: () => fixedTime,
    });
    const copiedRoot = parseYaml(plan.files.find(
      (file) => file.relativePath === join('workflows', 'arpeggio-assets.yaml'),
    )?.content ?? '') as {
      description?: string;
      steps?: Array<{ arpeggio?: { source_path?: string; template?: string } }>;
    };
    const sourceRefs = copiedRoot.steps?.map((step) => step.arpeggio?.source_path);
    expect(sourceRefs?.[0]).toBe(sourceRefs?.[2]);
    expect(sourceRefs?.[0]).not.toBe(sourceRefs?.[1]);
    expect(new Set(copiedRoot.steps?.map((step) => step.arpeggio?.template))).toHaveLength(1);
    expect(copiedRoot.description).toBe('custom-report-order and ../../rows.csv are examples only');
    expect(plan.files.filter((file) => dirname(file.relativePath) === 'assets').map((file) => file.content)).toEqual(
      expect.arrayContaining(['FIRST_INPUT\n', 'SECOND_INPUT\n', 'Process {value}.\n']),
    );
    expect(plan.files.filter((file) => dirname(file.relativePath) === 'assets')).toHaveLength(3);
  });

  it('uses a step fragment source package as the Arpeggio asset boundary', async () => {
    const rootPath = writeFixture('.takt/workflows/fragment-assets.yaml', `name: fragment-assets
initial_step: batch
max_steps: 1
steps:
  - uses: "@owner/pkg/repertoire-batch"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeConfigFixture('repertoire/@owner/pkg/steps/repertoire-batch.yaml', `name: batch
instruction: Process the package source.
arpeggio:
  source: csv
  source_path: ../assets/package.csv
  template: ../assets/package.md
  merge:
    strategy: custom
    file: ../assets/package.cjs
`);
    writeConfigFixture('repertoire/@owner/pkg/assets/package.csv', 'value\npackage\n');
    writeConfigFixture('repertoire/@owner/pkg/assets/package.md', 'Process package {value}.\n');
    writeConfigFixture('repertoire/@owner/pkg/assets/package.cjs', 'export default (items) => items.join("\\n");\n');

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'fragment-assets', 'project'),
      now: () => fixedTime,
    });
    await materializeWorkflowMakerArtifact(plan);
    rmSync(join(configDir, 'repertoire', '@owner', 'pkg'), { recursive: true, force: true });
    rmSync(rootPath, { force: true });

    const loaded = loadWorkflowFromFile(plan.rootWorkflowPath, projectDir, {
      resourceRoot: plan.artifactRoot,
    });
    expect(() => prepareWorkflowExecutionBundle({
      rootWorkflow: loaded,
      workflowCallResolver: () => null,
      projectCwd: projectDir,
      lookupCwd: plan.artifactRoot,
    })).not.toThrow();
  });

  it.each([
    ['source_path', 'source.csv'],
    ['template', 'template.md'],
    ['merge.file', 'merge.cjs'],
  ] as const)('rejects a missing Arpeggio %s asset before writing', async (_field, missingName) => {
    const rootPath = writeFixture('.takt/workflows/missing-arpeggio-asset.yaml', `name: missing-arpeggio-asset
initial_step: batch
max_steps: 1
steps:
  - name: batch
    instruction: Process the source.
    arpeggio:
      source: csv
      source_path: ../assets/source.csv
      template: ../assets/template.md
      merge:
        strategy: custom
        file: ../assets/merge.cjs
`);
    if (missingName !== 'source.csv') writeFixture('.takt/assets/source.csv', 'value\nsource\n');
    if (missingName !== 'template.md') writeFixture('.takt/assets/template.md', 'Process {value}.\n');
    if (missingName !== 'merge.cjs') writeFixture('.takt/assets/merge.cjs', 'export default (items) => items.join("\\n");\n');

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'missing-arpeggio-asset', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(new RegExp(missingName.replace('.', '\\.')));
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('accepts Arpeggio assets inside their source root and rejects escapes and symlinks', async () => {
    const outside = writeFixture('outside.csv', 'value\noutside\n');
    const rootPath = writeFixture('.takt/workflows/arpeggio-path-boundary.yaml', `name: arpeggio-path-boundary
initial_step: batch
max_steps: 1
steps:
  - name: batch
    instruction: Process the source.
    arpeggio:
      source: csv
      source_path: ../assets/source.csv
      template: ../assets/template.md
`);
    writeFixture('.takt/assets/source.csv', 'value\ninside\n');
    writeFixture('.takt/assets/template.md', 'Process {value}.\n');
    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'arpeggio-path-boundary', 'project'),
      now: () => fixedTime,
    })).resolves.toEqual(expect.objectContaining({ workflowName: 'arpeggio-path-boundary' }));

    writeFileSync(rootPath, readFileSync(rootPath, 'utf-8').replace('../assets/source.csv', outside));
    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'arpeggio-path-boundary', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/outside every allowed root/);

    writeFileSync(rootPath, readFileSync(rootPath, 'utf-8').replace(outside, '../../outside.csv'));
    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'arpeggio-path-boundary', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/outside every allowed root/);

    writeFileSync(rootPath, readFileSync(rootPath, 'utf-8').replace('../../outside.csv', '../assets/link.csv'));
    symlinkSync(outside, join(projectDir, '.takt', 'assets', 'link.csv'));
    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'arpeggio-path-boundary', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/symlink/);
  });

  it('copies only resolved reference nodes and their transitive dependencies', async () => {
    const rootPath = writeFixture('.takt/workflows/maker-base.yaml', `name: maker-base
description: "uses: shared-step"
initial_step: shared-step
max_steps: 2
instructions:
  maker: ../facets/instructions/maker.md
facet_pools:
  review:
    uses: review-pool
steps:
  - uses: shared-step
    rules:
      - condition: done
        next: COMPLETE
`);
    const stepPath = writeFixture('.takt/steps/shared-step.yaml', `instruction: maker
dynamic_facets:
  pool: review
  max_selected: 1
`);
    const poolPath = writeFixture('.takt/facet-pools/review-pool.yaml', `policies:
  strict: ./facets/policies/strict.md
candidates:
  - id: strict
    description: Apply the strict policy
    policy: strict
`);
    const poolFacetPath = writeFixture(
      '.takt/facet-pools/facets/policies/strict.md',
      '{extends:parent}\n# Strict policy\n',
    );
    const poolParentFacetPath = writeFixture(
      '.takt/facet-pools/facets/policies/parent.md',
      '# Parent policy\n',
    );
    const instructionPath = writeFixture(
      '.takt/facets/instructions/maker.md',
      'Create the workflow.\n\n{{include:instructions/common}}\n',
    );
    const partialPath = writeFixture(
      '.takt/facets/partials/instructions/common.md',
      'Shared instruction rules.\n',
    );
    const originalContents = new Map(
      [rootPath, stepPath, poolPath, poolFacetPath, poolParentFacetPath, instructionPath, partialPath]
        .map((path) => [path, readFileSync(path, 'utf-8')]),
    );

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'maker-base', 'project'),
      now: () => fixedTime,
    });

    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);

    await materializeWorkflowMakerArtifact(plan);

    const copiedRoot = join(plan.artifactRoot, 'workflows', 'maker-base.yaml');
    const copiedConfig = parseYaml(readFileSync(copiedRoot, 'utf-8')) as {
      description?: string;
      steps?: Array<{ uses?: string }>;
    };
    expect(copiedConfig.description).toBe('uses: shared-step');
    expect(copiedConfig.steps?.[0]?.uses).toEqual(expect.any(String));
    expect(copiedConfig.steps?.[0]?.uses).not.toMatch(/^@/);
    expect(existsSync(join(plan.artifactRoot, 'steps', 'shared-step.yaml'))).toBe(true);
    expect(existsSync(join(plan.artifactRoot, 'facet-pools', 'review-pool.yaml'))).toBe(true);
    expect(existsSync(join(plan.artifactRoot, 'facets', 'policies', 'strict.md'))).toBe(true);
    expect(existsSync(join(plan.artifactRoot, 'facets', 'policies', 'parent.md'))).toBe(true);
    expect(existsSync(join(plan.artifactRoot, 'facets', 'instructions', 'maker.md'))).toBe(true);
    expect(existsSync(join(plan.artifactRoot, 'facets', 'partials', 'instructions', 'common.md'))).toBe(true);
    expect(existsSync(join(plan.artifactRoot, 'manifest.yaml'))).toBe(false);
    for (const [path, content] of originalContents) {
      expect(readFileSync(path, 'utf-8')).toBe(content);
    }
    for (const path of originalContents.keys()) {
      rmSync(path);
    }
    expect(() => loadWorkflowFromFile(copiedRoot, projectDir, {
      resourceRoot: plan.artifactRoot,
    })).not.toThrow();
  });

  it('does not resolve an external pool facet parent from a higher-priority source layer', async () => {
    const rootPath = writeFixture('.takt/workflows/global-pool-base.yaml', `name: global-pool-base
facet_pools:
  review:
    uses: global-review
initial_step: review
max_steps: 1
steps:
  - name: review
    instruction: Review directly.
    dynamic_facets:
      pool: review
`);
    writeConfigFixture('facet-pools/global-review.yaml', `policies:
  strict: ./facets/policies/child.md
candidates:
  - id: strict
    description: Apply the strict policy
    policy: strict
`);
    writeConfigFixture(
      'facet-pools/facets/policies/child.md',
      '{extends:project-parent}\n# Child policy\n',
    );
    writeFixture('.takt/facets/policies/project-parent.md', '# Project parent\n');

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'global-pool-base', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/project-parent/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('does not resolve an external pool candidate facet from a higher-priority source layer', async () => {
    const rootPath = writeFixture('.takt/workflows/global-pool-candidate-base.yaml', `name: global-pool-candidate-base
facet_pools:
  review:
    uses: global-candidate-review
initial_step: review
max_steps: 1
steps:
  - name: review
    instruction: Review directly.
    dynamic_facets:
      pool: review
`);
    writeConfigFixture('facet-pools/global-candidate-review.yaml', `candidates:
  - id: project-only
    description: Apply a project-only policy
    policy: project-only
`);
    writeFixture('.takt/facets/policies/project-only.md', '# Project-only policy\n');

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'global-pool-candidate-base', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/project-only/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('copies transitive facet includes from an external pool', async () => {
    const rootPath = writeFixture('.takt/workflows/global-pool-nested-include-base.yaml', `name: global-pool-nested-include-base
facet_pools:
  review:
    uses: global-nested-include-review
initial_step: review
max_steps: 1
steps:
  - name: review
    instruction: Review directly.
    dynamic_facets:
      pool: review
`);
    const poolPath = writeConfigFixture('facet-pools/global-nested-include-review.yaml', `policies:
  strict: ./facets/policies/strict.md
candidates:
  - id: strict
    description: Apply the strict policy
    policy: strict
`);
    const policyPath = writeConfigFixture(
      'facet-pools/facets/policies/strict.md',
      '# Strict policy\n\n{{include:instructions/first}}\n',
    );
    const firstPartialPath = writeConfigFixture(
      'facet-pools/facets/partials/instructions/first.md',
      'First partial.\n\n{{include:instructions/second}}\n',
    );
    const secondPartialPath = writeConfigFixture(
      'facet-pools/facets/partials/instructions/second.md',
      'Second partial.\n',
    );

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'global-pool-nested-include-base', 'project'),
      now: () => fixedTime,
    });
    await materializeWorkflowMakerArtifact(plan);

    const copiedRoot = join(plan.artifactRoot, 'workflows', 'global-pool-nested-include-base.yaml');
    expect(existsSync(join(
      plan.artifactRoot,
      'facets',
      'partials',
      'instructions',
      'first.md',
    ))).toBe(true);
    expect(existsSync(join(
      plan.artifactRoot,
      'facets',
      'partials',
      'instructions',
      'second.md',
    ))).toBe(true);

    for (const sourcePath of [rootPath, poolPath, policyPath, firstPartialPath, secondPartialPath]) {
      rmSync(sourcePath);
    }
    expect(() => loadWorkflowFromFile(copiedRoot, projectDir, {
      resourceRoot: plan.artifactRoot,
    })).not.toThrow();
  });

  it('does not resolve an external pool facet include from a higher-priority source layer', async () => {
    const rootPath = writeFixture('.takt/workflows/global-pool-include-base.yaml', `name: global-pool-include-base
facet_pools:
  review:
    uses: global-include-review
initial_step: review
max_steps: 1
steps:
  - name: review
    instruction: Review directly.
    dynamic_facets:
      pool: review
`);
    writeConfigFixture('facet-pools/global-include-review.yaml', `policies:
  strict: ./facets/policies/strict.md
candidates:
  - id: strict
    description: Apply the strict policy
    policy: strict
`);
    writeConfigFixture(
      'facet-pools/facets/policies/strict.md',
      '# Strict policy\n\n{{include:instructions/project-only}}\n',
    );
    writeFixture(
      '.takt/facets/partials/instructions/project-only.md',
      'Project-only partial.\n',
    );

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'global-pool-include-base', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/instructions\/project-only/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('ignores reference-like code examples but rejects an unbound dynamic reference before writing', async () => {
    const rootPath = writeFixture('.takt/workflows/dynamic-base.yaml', `name: dynamic-base
initial_step: dynamic
max_steps: 1
instructions:
  maker: ../facets/instructions/maker.md
steps:
  - uses: $dynamic_step
`);
    writeFixture('.takt/facets/instructions/maker.md', `Use this example:

\`\`\`yaml
uses: missing-step
\`\`\`
`);

    const planning = Promise.resolve().then(() => planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'dynamic-base', 'project'),
      now: () => fixedTime,
    }));

    await expect(planning).rejects.toThrow(/\$dynamic_step/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);

    writeFileSync(rootPath, `name: dynamic-base
initial_step: dynamic
max_steps: 1
steps:
  - uses:
      $param: dynamic_step
`, 'utf-8');
    const parameterizedPlanning = Promise.resolve().then(() => planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'dynamic-base', 'project'),
      now: () => fixedTime,
    }));

    await expect(parameterizedPlanning).rejects.toThrow(/\$param/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('keeps same-named dependencies distinct and preserves the first run when the clock repeats', async () => {
    const rootPath = writeFixture('.takt/workflows/colliding-base.yaml', `name: colliding-base
initial_step: project-shared
max_steps: 3
steps:
  - name: project-shared
    uses: shared
    rules:
      - condition: done
        next: repertoire-shared
  - name: repertoire-shared
    uses: "@owner/pkg/shared"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFixture('.takt/steps/shared.yaml', 'instruction: PROJECT SHARED\n');
    writeConfigFixture(
      'repertoire/@owner/pkg/steps/shared.yaml',
      'instruction: REPERTOIRE SHARED\n',
    );

    const firstPlan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'colliding-base', 'project'),
      now: () => fixedTime,
    });
    await materializeWorkflowMakerArtifact(firstPlan);

    const firstRootPath = join(firstPlan.artifactRoot, 'workflows', 'colliding-base.yaml');
    const firstRoot = parseYaml(readFileSync(firstRootPath, 'utf-8')) as {
      steps?: Array<{ uses?: string }>;
    };
    const copiedUses = firstRoot.steps?.map((step) => step.uses);
    const copiedStepContents = listFiles(join(firstPlan.artifactRoot, 'steps'))
      .map((path) => readFileSync(join(firstPlan.artifactRoot, 'steps', path), 'utf-8'));
    expect(copiedUses).toHaveLength(2);
    if (copiedUses === undefined) {
      throw new Error('Copied workflow is missing its steps');
    }
    expect(new Set(copiedUses).size).toBe(2);
    expect(copiedUses.every((value) => value !== undefined && !value.startsWith('@'))).toBe(true);
    expect(copiedStepContents).toEqual(expect.arrayContaining([
      'instruction: PROJECT SHARED\n',
      'instruction: REPERTOIRE SHARED\n',
    ]));
    const firstSnapshot = new Map(
      listFiles(firstPlan.artifactRoot)
        .map((path) => [path, readFileSync(join(firstPlan.artifactRoot, path), 'utf-8')]),
    );

    const secondPlan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'colliding-base', 'project'),
      now: () => fixedTime,
    });
    await materializeWorkflowMakerArtifact(secondPlan);

    expect(secondPlan.artifactRoot).not.toBe(firstPlan.artifactRoot);
    for (const [path, content] of firstSnapshot) {
      expect(readFileSync(join(firstPlan.artifactRoot, path), 'utf-8')).toBe(content);
    }
  });

  it('rejects an unsafe New workflow name before returning an artifact plan', async () => {
    const planning = Promise.resolve().then(() => planWorkflowMakerArtifact({
      projectDir,
      base: { kind: 'new' as const, name: '../outside' },
      now: () => fixedTime,
    }));

    await expect(planning).rejects.toThrow();
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
    expect(existsSync(join(projectDir, '..', 'outside.yaml'))).toBe(false);
  });

  it('does not reuse or overwrite an occupied timestamp directory', async () => {
    const occupiedRoot = join(projectDir, '.takt', 'make', '20260102-030405-006');
    const sentinelPath = join(occupiedRoot, 'sentinel.txt');
    mkdirSync(occupiedRoot, { recursive: true });
    writeFileSync(sentinelPath, 'original', 'utf-8');

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: { kind: 'new' as const, name: 'safe-workflow' },
      now: () => fixedTime,
    });

    expect(plan.artifactRoot).not.toBe(occupiedRoot);
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('original');
    expect(existsSync(plan.artifactRoot)).toBe(false);
  });

  it('copies loop-monitor, team-leader, schema, facet inheritance, and pool candidate dependencies', async () => {
    const rootPath = writeFixture('.takt/workflows/closure.yaml', `name: closure
description: worker
personas:
  local-leader: ../facets/personas/leader-source.md
  local-worker: ../facets/personas/worker-source.md
schemas:
  answer: answer-schema
facet_pools:
  reviewers:
    policies:
      strict: ../facets/policies/child.md
    candidates:
      - id: strict
        description: strict review
        policy: strict
loop_monitors:
  - cycle: [work, review]
    judge:
      persona: local-leader
      instruction: Judge this cycle directly.
      rules:
        - condition: continue
          next: work
initial_step: work
max_steps: 2
steps:
  - name: work
    persona: local-leader
    instruction: Implement this workflow directly.
    structured_output:
      schema_ref: answer
    team_leader:
      persona: local-leader
      part_persona: local-worker
    rules:
      - condition: done
        next: COMPLETE
  - name: review
    instruction: Review this workflow directly.
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFixture('.takt/facets/personas/leader-source.md', '# leader\n');
    writeFixture('.takt/facets/personas/worker-source.md', '# worker\n');
    writeFixture('.takt/facets/policies/parent.md', '# parent\n');
    writeFixture('.takt/facets/policies/child.md', '{extends:parent}\n# child\n');
    writeFixture('.takt/schemas/answer-schema.json', '{"type":"object"}\n');

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'closure', 'project'),
      now: () => fixedTime,
    });
    await materializeWorkflowMakerArtifact(plan);

    const copiedRoot = join(plan.artifactRoot, 'workflows', 'closure.yaml');
    expect(listFiles(plan.artifactRoot)).toEqual(expect.arrayContaining([
      join('facets', 'personas', 'leader-source.md'),
      join('facets', 'personas', 'worker-source.md'),
      join('facets', 'policies', 'child.md'),
      join('facets', 'policies', 'parent.md'),
      join('schemas', 'answer-schema.json'),
    ]));
    rmSync(join(projectDir, '.takt', 'facets'), { recursive: true, force: true });
    rmSync(join(projectDir, '.takt', 'schemas'), { recursive: true, force: true });
    rmSync(rootPath);
    const loaded = loadWorkflowFromFile(copiedRoot, projectDir, {
      resourceRoot: plan.artifactRoot,
    });
    const teamLeader = findAgentWorkflowStep(loaded, 'work').teamLeader;
    expect(teamLeader?.providerRoutingPersonaKey).toBe('local-leader');
    expect(teamLeader?.partPersonaRef).toBe('local-worker');
    expect(readFileSync(teamLeader!.personaPath!, 'utf-8')).toBe('# leader\n');
    expect(readFileSync(teamLeader!.partPersonaPath!, 'utf-8')).toBe('# worker\n');
    expect(readFileSync(copiedRoot, 'utf-8')).toContain('description: worker');
  });

  it('rejects unresolved named personas but preserves inline instructions before writing', async () => {
    const rootPath = writeFixture('.takt/workflows/facet-boundary.yaml', `name: facet-boundary
initial_step: work
max_steps: 1
steps:
  - name: work
    persona: missing-persona
    instruction: Implement this workflow directly.
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'facet-boundary', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/missing-persona/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);

    writeFixture('.takt/facets/personas/worker.md', '# worker\n');
    writeFileSync(rootPath, readFileSync(rootPath, 'utf-8').replace('missing-persona', 'worker'));
    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'facet-boundary', 'project'),
      now: () => fixedTime,
    });
    const copied = plan.files.find((file) => file.relativePath === join('workflows', 'facet-boundary.yaml'));
    expect(copied?.content).toContain('instruction: Implement this workflow directly.');
  });

  it.each([
    ['workflow section', `personas:
  reviewer: ./missing-section-persona.md`, 'missing-section-persona'],
    ['facet pool section', `facet_pools:
  reviewers:
    policies:
      strict: ./missing-section-policy.md
    candidates:
      - id: strict
        description: Apply strict review
        policy: strict`, 'missing-section-policy'],
  ] as const)('rejects an unresolved named facet in a %s before writing', async (_case, section, reference) => {
    const rootPath = writeFixture('.takt/workflows/unresolved-section-facet.yaml', `name: unresolved-section-facet
${section}
initial_step: work
max_steps: 1
steps:
  - name: work
    instruction: Do work directly.
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'unresolved-section-facet', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(new RegExp(reference));
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('preserves inline section facets and their local aliases after source removal', async () => {
    const rootPath = writeFixture('.takt/workflows/inline-section-facets.yaml', `name: inline-section-facets
instructions:
  local-instruction: OK
facet_pools:
  reviewers:
    policies:
      local-policy: Review with the inline policy.
    candidates:
      - id: strict
        description: Apply strict review
        policy: local-policy
initial_step: work
max_steps: 1
steps:
  - name: work
    instruction: local-instruction
    dynamic_facets:
      pool: reviewers
    rules:
      - condition: done
        next: COMPLETE
`);
    const collidingInstructionPath = writeFixture(
      '.takt/facets/instructions/OK.md',
      'COLLIDING_FILE_CONTENT\n',
    );

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'inline-section-facets', 'project'),
      now: () => fixedTime,
    });
    await materializeWorkflowMakerArtifact(plan);

    const copiedWorkflow = parseYaml(readFileSync(plan.rootWorkflowPath, 'utf-8')) as {
      instructions?: Record<string, string>;
    };
    expect(copiedWorkflow.instructions?.['local-instruction']).toBe('OK');
    expect(existsSync(join(plan.artifactRoot, 'facets', 'instructions', 'OK.md'))).toBe(false);
    rmSync(rootPath);
    rmSync(collidingInstructionPath);
    const loaded = loadWorkflowFromFile(plan.rootWorkflowPath, projectDir, {
      resourceRoot: plan.artifactRoot,
    });
    expect(findAgentWorkflowStep(loaded, 'work').instruction).toBe(
      'OK',
    );
    expect(loaded.facetPools?.reviewers?.candidates[0]?.resolvedPolicyContents).toEqual([
      expect.objectContaining({ content: 'Review with the inline policy.' }),
    ]);
  });

  it.each([
    ['policy', 'missing-policy'],
    ['knowledge', 'missing-knowledge'],
  ] as const)('rejects an unresolved named %s before writing', async (field, reference) => {
    const rootPath = writeFixture('.takt/workflows/unresolved-facet.yaml', `name: unresolved-facet
initial_step: work
max_steps: 1
steps:
  - name: work
    ${field}: ${reference}
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'unresolved-facet', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(new RegExp(reference));
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it.each([
    ['direct step', false],
    ['step fragment', true],
  ] as const)('preserves a one-word inline instruction in a %s', async (_case, useFragment) => {
    const rootPath = writeFixture('.takt/workflows/one-word-instruction.yaml', `name: one-word-instruction
initial_step: plan
max_steps: 1
steps:
  - ${useFragment
    ? 'uses: one-word-step\n    rules:\n      - condition: done\n        next: COMPLETE'
    : 'name: plan\n    instruction: Plan'}
`);
    if (useFragment) {
      writeFixture('.takt/steps/one-word-step.yaml', `name: plan
instruction: Plan
`);
    }

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'one-word-instruction', 'project'),
      now: () => fixedTime,
    });
    await materializeWorkflowMakerArtifact(plan);
    rmSync(rootPath);
    rmSync(join(projectDir, '.takt', 'steps'), { recursive: true, force: true });

    const loaded = loadWorkflowFromFile(plan.rootWorkflowPath, projectDir, {
      resourceRoot: plan.artifactRoot,
    });
    expect(findAgentWorkflowStep(loaded, 'plan').instruction).toBe('Plan');
  });

  it('rejects an unresolved explicit instruction path before writing', async () => {
    const rootPath = writeFixture('.takt/workflows/missing-instruction-path.yaml', `name: missing-instruction-path
initial_step: plan
max_steps: 1
steps:
  - name: plan
    instruction: ./missing.md
`);

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'missing-instruction-path', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/missing\.md/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it.each([
    ['subworkflow facet-pool default', `subworkflow:
  params:
    selected_pool:
      type: facet_pool_ref
      default: toString
facet_pools: {}`],
    ['facet-pool candidate alias', `facet_pools:
  review:
    policies: {}
    candidates:
      - id: inherited
        description: inherited alias
        policy: toString`],
    ['dynamic facet-pool alias', `facet_pools: {}
steps:
  - name: plan
    instruction: Plan directly.
    dynamic_facets:
      pool: toString`],
    ['report format alias', `report_formats: {}
steps:
  - name: plan
    instruction: Plan directly.
    output_contracts:
      report:
        - name: report.md
          format: toString`],
    ['workflow-call facet-pool argument', `steps:
  - call: inherited-pool-child
    args:
      selected_pool: toString`],
    ['direct facet alias', `personas: {}
steps:
  - name: plan
    persona: toString
    instruction: Plan directly.`],
  ] as const)('rejects a prototype-inherited %s before writing', async (caseName, section) => {
    if (caseName === 'workflow-call facet-pool argument') {
      writeFixture('.takt/workflows/inherited-pool-child.yaml', `name: inherited-pool-child
subworkflow:
  callable: true
  params:
    selected_pool:
      type: facet_pool_ref
facet_pools: {}
initial_step: child
max_steps: 1
steps:
  - name: child
    instruction: Child work.
`);
    }
    const hasSteps = section.includes('steps:');
    const rootPath = writeFixture('.takt/workflows/inherited-property.yaml', `name: inherited-property
${section}
initial_step: plan
max_steps: 1
${hasSteps ? '' : `steps:
  - name: plan
    instruction: Plan directly.
`}`);

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'inherited-property', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/toString/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('keeps own prototype-named aliases local and copies their dependencies', async () => {
    const rootPath = writeFixture('.takt/workflows/own-property.yaml', `name: own-property
personas:
  toString: ../facets/personas/reviewer.md
facet_pools:
  constructor:
    policies:
      toString: ../facets/policies/strict.md
    candidates:
      - id: strict
        description: strict review
        policy: toString
initial_step: review
max_steps: 1
steps:
  - name: review
    persona: toString
    instruction: Review directly.
    dynamic_facets:
      pool: constructor
`);
    writeFixture('.takt/facets/personas/reviewer.md', '# reviewer\n');
    writeFixture('.takt/facets/policies/strict.md', '# strict\n');

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'own-property', 'project'),
      now: () => fixedTime,
    });
    const plannedRoot = parseYaml(plan.files.find(
      (file) => file.relativePath === join('workflows', 'own-property.yaml'),
    )?.content ?? '') as {
      steps?: Array<{ persona?: string; dynamic_facets?: { pool?: string } }>;
    };
    expect(plannedRoot.steps?.[0]).toEqual(expect.objectContaining({
      persona: 'toString',
      dynamic_facets: expect.objectContaining({ pool: 'constructor' }),
    }));
    expect(plan.files.map((file) => file.relativePath)).toEqual(expect.arrayContaining([
      join('facets', 'personas', 'reviewer.md'),
      join('facets', 'policies', 'strict.md'),
    ]));
  });

  it('rejects an unresolved completion retry instruction before writing', async () => {
    const rootPath = writeFixture('.takt/workflows/missing-retry-instruction.yaml', `name: missing-retry-instruction
initial_step: work
max_steps: 1
steps:
  - name: work
    instruction: Work directly.
    completion_retry:
      retry_instruction: missing-retry-instruction
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'missing-retry-instruction', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/missing-retry-instruction/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('preserves completion retry local aliases and inline instructions', async () => {
    const rootPath = writeFixture('.takt/workflows/retry-instructions.yaml', `name: retry-instructions
instructions:
  retry-local: ../facets/instructions/retry-local.md
initial_step: local
max_steps: 2
steps:
  - name: local
    instruction: Work with a local retry instruction.
    completion_retry:
      retry_instruction: retry-local
    rules:
      - condition: done
        next: inline
  - name: inline
    instruction: Work with an inline retry instruction.
    completion_retry:
      retry_instruction: Retry this step directly.
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFixture(
      '.takt/facets/instructions/retry-local.md',
      'Retry using the local instruction.\n',
    );

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'retry-instructions', 'project'),
      now: () => fixedTime,
    });
    const copied = plan.files.find(
      (file) => file.relativePath === join('workflows', 'retry-instructions.yaml'),
    );
    const copiedWorkflow = parseYaml(copied?.content ?? '') as {
      steps?: Array<{ completion_retry?: { retry_instruction?: string } }>;
    };
    expect(copiedWorkflow.steps?.[0]?.completion_retry?.retry_instruction).toBe('retry-local');
    expect(copiedWorkflow.steps?.[1]?.completion_retry?.retry_instruction).toBe(
      'Retry this step directly.',
    );
    await materializeWorkflowMakerArtifact(plan);

    const copiedRoot = join(plan.artifactRoot, 'workflows', 'retry-instructions.yaml');
    rmSync(join(projectDir, '.takt', 'facets'), { recursive: true, force: true });
    rmSync(rootPath);
    const loaded = loadWorkflowFromFile(copiedRoot, projectDir, {
      resourceRoot: plan.artifactRoot,
    });
    expect(findAgentWorkflowStep(loaded, 'local').completionRetry?.retryInstruction).toBe(
      'Retry using the local instruction.\n',
    );
    expect(findAgentWorkflowStep(loaded, 'inline').completionRetry?.retryInstruction).toBe(
      'Retry this step directly.',
    );
  });

  it('copies dynamic facet selector dependencies into an independently loadable artifact', async () => {
    const rootPath = writeFixture('.takt/workflows/dynamic-selector.yaml', `name: dynamic-selector
facet_pools:
  reviewers:
    policies:
      strict: ../facets/policies/strict.md
    candidates:
      - id: strict
        description: Apply strict review
        policy: strict
initial_step: review
max_steps: 1
steps:
  - name: review
    instruction: Review this workflow directly.
    dynamic_facets:
      pool: reviewers
      selector:
        persona: selector-persona
        instruction: selector-instruction
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFixture('.takt/facets/personas/selector-persona.md', '# selector persona\n');
    writeFixture('.takt/facets/instructions/selector-instruction.md', 'Choose review facets.\n');
    writeFixture('.takt/facets/policies/strict.md', '# strict\n');

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'dynamic-selector', 'project'),
      now: () => fixedTime,
    });
    await materializeWorkflowMakerArtifact(plan);

    const copiedRoot = join(plan.artifactRoot, 'workflows', 'dynamic-selector.yaml');
    expect(listFiles(plan.artifactRoot)).toEqual(expect.arrayContaining([
      join('facets', 'personas', 'selector-persona.md'),
      join('facets', 'instructions', 'selector-instruction.md'),
    ]));
    rmSync(join(projectDir, '.takt', 'facets'), { recursive: true, force: true });
    rmSync(rootPath);
    expect(() => loadWorkflowFromFile(copiedRoot, projectDir, {
      resourceRoot: plan.artifactRoot,
    })).not.toThrow();
  });

  it('rejects an unresolved dynamic facet selector reference before writing', async () => {
    const rootPath = writeFixture('.takt/workflows/missing-selector.yaml', `name: missing-selector
facet_pools:
  reviewers:
    policies:
      strict: ../facets/policies/strict.md
    candidates:
      - id: strict
        description: Apply strict review
        policy: strict
initial_step: review
max_steps: 1
steps:
  - name: review
    instruction: Review this workflow directly.
    dynamic_facets:
      pool: reviewers
      selector:
        instruction: missing-selector-instruction
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFixture('.takt/facets/policies/strict.md', '# strict\n');

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'missing-selector', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/missing-selector-instruction/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('reuses a completed child workflow referenced by multiple steps', async () => {
    const rootPath = writeFixture('.takt/workflows/reuse-parent.yaml', `name: reuse-parent
initial_step: first
max_steps: 2
steps:
  - name: first
    kind: workflow_call
    call: ./reuse-child.yaml
    rules:
      - condition: ok
        next: second
  - name: second
    kind: workflow_call
    call: ./reuse-child.yaml
    rules:
      - condition: ok
        next: COMPLETE
`);
    writeFixture('.takt/workflows/reuse-child.yaml', `name: reuse-child
subworkflow:
  callable: true
  returns: [ok]
initial_step: work
max_steps: 1
steps:
  - name: work
    instruction: Complete the child workflow directly.
    rules:
      - condition: done
        return: ok
`);

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'reuse-parent', 'project'),
      now: () => fixedTime,
    });
    expect(plan.files.filter((file) => dirname(file.relativePath) === 'workflows')).toHaveLength(2);
    await materializeWorkflowMakerArtifact(plan);

    const copiedRoot = join(plan.artifactRoot, 'workflows', 'reuse-parent.yaml');
    rmSync(join(projectDir, '.takt', 'workflows'), { recursive: true, force: true });
    expect(() => loadWorkflowFromFile(copiedRoot, projectDir, {
      resourceRoot: plan.artifactRoot,
    })).not.toThrow();
  });

  it('rejects a recursive workflow call before writing', async () => {
    const rootPath = writeFixture('.takt/workflows/cycle-a.yaml', `name: cycle-a
initial_step: delegate
max_steps: 1
steps:
  - name: delegate
    kind: workflow_call
    call: ./cycle-b.yaml
`);
    writeFixture('.takt/workflows/cycle-b.yaml', `name: cycle-b
initial_step: delegate
max_steps: 1
steps:
  - name: delegate
    kind: workflow_call
    call: ./cycle-a.yaml
`);

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'cycle-a', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/workflow dependency cycle/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('preserves loop monitor local aliases and inline instructions', async () => {
    const rootPath = writeFixture('.takt/workflows/monitor-facets.yaml', `name: monitor-facets
personas:
  monitor: ../facets/personas/monitor-source.md
instructions:
  monitor-check: ../facets/instructions/monitor-source.md
loop_monitors:
  - cycle: [work, review]
    judge:
      persona: monitor
      instruction: monitor-check
      rules:
        - condition: continue
          next: work
  - cycle: [review, work]
    judge:
      instruction: Judge this cycle directly.
      rules:
        - condition: continue
          next: review
initial_step: work
max_steps: 2
steps:
  - name: work
    instruction: Work directly.
    rules:
      - condition: done
        next: review
  - name: review
    instruction: Review directly.
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFixture('.takt/facets/personas/monitor-source.md', '# monitor persona\n');
    writeFixture('.takt/facets/instructions/monitor-source.md', 'Judge using the local instruction.\n');

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'monitor-facets', 'project'),
      now: () => fixedTime,
    });
    const copied = plan.files.find((file) => file.relativePath === join('workflows', 'monitor-facets.yaml'));
    const copiedWorkflow = parseYaml(copied?.content ?? '') as {
      loop_monitors?: Array<{ judge?: { persona?: string; instruction?: string } }>;
    };
    expect(copiedWorkflow.loop_monitors?.[0]?.judge).toEqual(expect.objectContaining({
      persona: 'monitor',
      instruction: 'monitor-check',
    }));
    expect(copiedWorkflow.loop_monitors?.[1]?.judge?.instruction).toBe('Judge this cycle directly.');
    await materializeWorkflowMakerArtifact(plan);

    const copiedRoot = join(plan.artifactRoot, 'workflows', 'monitor-facets.yaml');
    rmSync(join(projectDir, '.takt', 'facets'), { recursive: true, force: true });
    rmSync(rootPath);
    expect(() => loadWorkflowFromFile(copiedRoot, projectDir, {
      resourceRoot: plan.artifactRoot,
    })).not.toThrow();
  });

  it('rejects an unresolved loop monitor instruction before writing', async () => {
    const rootPath = writeFixture('.takt/workflows/missing-monitor-instruction.yaml', `name: missing-monitor-instruction
loop_monitors:
  - cycle: [work, review]
    judge:
      instruction: missing-monitor-instruction
      rules:
        - condition: continue
          next: work
initial_step: work
max_steps: 2
steps:
  - name: work
    instruction: Work directly.
    rules:
      - condition: done
        next: review
  - name: review
    instruction: Review directly.
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'missing-monitor-instruction', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/missing-monitor-instruction/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('accepts regular resources inside their root and rejects traversal and symlinks', async () => {
    const outside = writeFixture('outside.md', '# outside\n');
    const rootPath = writeFixture('.takt/workflows/path-boundary.yaml', `name: path-boundary
initial_step: work
max_steps: 1
steps:
  - name: work
    persona: ../facets/personas/leader.md
    instruction: Work directly.
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFixture('.takt/facets/personas/leader.md', '# leader\n');
    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'path-boundary', 'project'),
      now: () => fixedTime,
    })).resolves.toEqual(expect.objectContaining({ workflowName: 'path-boundary' }));

    writeFileSync(rootPath, readFileSync(rootPath, 'utf-8').replace(
      '../facets/personas/leader.md',
      '../../outside.md',
    ));
    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'path-boundary', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/outside every allowed root/);

    writeFileSync(rootPath, readFileSync(rootPath, 'utf-8').replace('../../outside.md', '../facets/personas/link.md'));
    symlinkSync(outside, join(projectDir, '.takt', 'facets', 'personas', 'link.md'));
    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'path-boundary', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/symlink/);
  });

  it('closes companion, capability, and cross-package facet dependencies inside the artifact', async () => {
    const rootPath = writeFixture('.takt/workflows/dependency-closure.yaml', `name: dependency-closure
description: missing-companion, missing-capability, and @missing/pkg/facet are not reference fields.
capabilities: readonly
instructions:
  retry-local: ../facets/instructions/retry-local.md
initial_step: work
max_steps: 2
steps:
  - name: work
    persona: "@other/pkg/reviewer"
    policy: "@other/pkg/strict"
    knowledge: "@other/pkg/domain"
    instruction: "@other/pkg/work"
    capabilities: readonly
    companion:
      fixed: [reviewer-a]
      pool: [reviewer-b]
      moderator: moderator-a
    output_contracts:
      report:
        - name: result.md
          format: "@other/pkg/report"
  - name: fanout
    instruction: Run reviews.
    capabilities: readonly
    parallel:
      - name: nested-review
        instruction: Review independently.
        capabilities: ./relative-capability.yaml
        completion_retry:
          retry_instruction: retry-local
  - name: dynamic-fanout
    instruction: Select reviews.
    parallel:
      fixed:
        - name: fixed-review
          instruction: Run the fixed review.
          capabilities: ./fixed-capability.yaml
          completion_retry:
            retry_instruction: Retry the fixed review directly.
      pool:
        - name: pool-review
          description: Run the optional pool review
          instruction: Run the pool review.
          capabilities: ./pool-capability.yaml
          completion_retry:
            retry_instruction: retry-local
`);
    writeFixture('.takt/provider-options/base-readonly.yaml', 'codex:\n  network_access: true\n');
    writeFixture('.takt/provider-options/readonly.yaml', `extends: base-readonly
claude:
  allowed_tools: [Read]
`);
    writeFixture('.takt/workflows/relative-capability.yaml', 'opencode:\n  network_access: true\n');
    writeFixture('.takt/workflows/fixed-capability.yaml', 'codex:\n  network_access: true\n');
    writeFixture('.takt/workflows/pool-capability.yaml', 'claude:\n  allowed_tools: [Read]\n');
    writeFixture('.takt/facets/instructions/retry-local.md', 'RETRY_LOCAL\n');
    for (const companion of ['reviewer-a', 'reviewer-b', 'moderator-a']) {
      writeFixture(`.takt/companions/${companion}.yaml`, `name: ${companion}
description: ${companion} definition
persona: "@other/pkg/reviewer"
policy: "@other/pkg/strict"
knowledge: "@other/pkg/domain"
${companion === 'moderator-a' ? '' : 'instruction: "@other/pkg/work"'}
`);
    }
    const facetFixtures = [
      ['personas', 'reviewer', 'SCOPED_PERSONA'],
      ['policies', 'strict', 'SCOPED_POLICY'],
      ['knowledge', 'domain', 'SCOPED_KNOWLEDGE'],
      ['instructions', 'work', 'SCOPED_INSTRUCTION'],
      ['output-contracts', 'report', 'SCOPED_REPORT'],
    ] as const;
    for (const [kind, name, marker] of facetFixtures) {
      writeConfigFixture(`repertoire/@other/pkg/facets/${kind}/${name}.md`, `${marker}\n`);
    }

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'dependency-closure', 'project'),
      now: () => fixedTime,
    });
    expect(plan.files.filter((file) => dirname(file.relativePath) === 'companions')).toHaveLength(3);
    expect(plan.files.filter((file) => dirname(file.relativePath) === 'provider-options')).toHaveLength(5);
    expect(plan.files.map((file) => file.relativePath)).toEqual(expect.arrayContaining(
      facetFixtures.map(([kind, name]) => join('facets', kind, `${name}.md`)),
    ));
    expect(plan.files.some(
      (file) => file.relativePath === join('facets', 'instructions', 'companion-watch-review.md'),
    )).toBe(true);
    await materializeWorkflowMakerArtifact(plan);

    rmSync(join(projectDir, '.takt', 'workflows'), { recursive: true, force: true });
    rmSync(join(projectDir, '.takt', 'companions'), { recursive: true, force: true });
    rmSync(join(projectDir, '.takt', 'provider-options'), { recursive: true, force: true });
    rmSync(join(projectDir, '.takt', 'facets'), { recursive: true, force: true });
    rmSync(join(configDir, 'repertoire', '@other', 'pkg'), { recursive: true, force: true });

    const loaded = loadWorkflowFromFile(plan.rootWorkflowPath, projectDir, {
      resourceRoot: plan.artifactRoot,
    });
    const work = findAgentWorkflowStep(loaded, 'work');
    expect(work.personaPath).toEqual(expect.any(String));
    expect(readFileSync(work.personaPath!, 'utf-8')).toBe('SCOPED_PERSONA\n');
    expect(work.policyContents?.map((entry) => entry.content)).toContain('SCOPED_POLICY\n');
    expect(work.knowledgeContents?.map((entry) => entry.content)).toContain('SCOPED_KNOWLEDGE\n');
    expect(work.instruction).toBe('SCOPED_INSTRUCTION\n');
    expect(work.outputContracts?.[0]?.format).toBe('SCOPED_REPORT\n');
    expect(work.capabilityProviderOptions).toEqual(expect.objectContaining({
      claude: expect.objectContaining({ allowedTools: ['Read'] }),
      codex: expect.objectContaining({ networkAccess: true }),
    }));
    expect(work.companion).toEqual({
      fixed: ['reviewer-a'],
      pool: ['reviewer-b'],
      moderator: 'moderator-a',
    });
    expect(Object.keys(loaded.companions ?? {})).toEqual(
      expect.arrayContaining(['reviewer-a', 'reviewer-b', 'moderator-a']),
    );
    expect(loaded.companions?.['reviewer-a']?.personaContent).toBe('SCOPED_PERSONA\n');
    expect(loaded.companions?.['reviewer-a']?.instruction).toBe('SCOPED_INSTRUCTION\n');
    expect(loaded.companions?.['reviewer-a']?.policyContents).toContain('SCOPED_POLICY\n');
    expect(loaded.companions?.['reviewer-a']?.knowledgeContents).toContain('SCOPED_KNOWLEDGE\n');
    expect(loaded.companions?.['moderator-a']?.instructionRef).toContain('companion-watch-review');

    const fanout = findWorkflowStep(loaded, 'fanout');
    if (!('parallel' in fanout) || !Array.isArray(fanout.parallel)) {
      throw new Error('Expected static parallel sub-steps');
    }
    const parallelSteps = fanout.parallel;
    const parallelFanout = fanout as ParallelWorkflowStep;
    expect(parallelFanout.capabilityProviderOptions?.claude?.allowedTools).toEqual(['Read']);
    expect(findAgentWorkflowStep({ ...loaded, steps: parallelSteps }, 'nested-review')
      .capabilityProviderOptions?.opencode?.networkAccess).toBe(true);
    expect(findAgentWorkflowStep({ ...loaded, steps: parallelSteps }, 'nested-review')
      .completionRetry?.retryInstruction).toBe('RETRY_LOCAL\n');

    const dynamicFanout = findWorkflowStep(loaded, 'dynamic-fanout');
    const dynamicParallel = 'parallel' in dynamicFanout ? dynamicFanout.parallel : undefined;
    if (dynamicParallel === undefined || !isDynamicParallelSubSteps(dynamicParallel)) {
      throw new Error('Expected dynamic parallel sub-steps');
    }
    expect(dynamicParallel.fixed[0]?.capabilityProviderOptions?.codex?.networkAccess).toBe(true);
    expect(dynamicParallel.fixed[0]?.completionRetry?.retryInstruction).toBe(
      'Retry the fixed review directly.',
    );
    expect(dynamicParallel.pool[0]?.capabilityProviderOptions?.claude?.allowedTools).toEqual(['Read']);
    expect(dynamicParallel.pool[0]?.completionRetry?.retryInstruction).toBe('RETRY_LOCAL\n');
  });

  it.each([
    ['static', `
      - name: static-review
        instruction: Review statically.
        completion_retry:
          retry_instruction: missing-parallel-retry`],
    ['dynamic fixed', `
      fixed:
        - name: fixed-review
          instruction: Review fixed work.
          completion_retry:
            retry_instruction: missing-parallel-retry
      pool:
        - name: pool-review
          description: Review optional work
          instruction: Review pool work.`],
    ['dynamic pool', `
      pool:
        - name: pool-review
          description: Review optional work
          instruction: Review pool work.
          completion_retry:
            retry_instruction: missing-parallel-retry`],
  ] as const)('rejects an unresolved completion retry instruction in a %s sub-step before writing', async (
    _kind,
    parallel,
  ) => {
    const rootPath = writeFixture('.takt/workflows/missing-parallel-retry.yaml', `name: missing-parallel-retry
initial_step: fanout
max_steps: 1
steps:
  - name: fanout
    instruction: Run reviews.
    parallel:${parallel}
`);

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'missing-parallel-retry', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/missing-parallel-retry/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('rewrites companion_ref defaults and explicit workflow_call selections', async () => {
    const rootPath = writeFixture('.takt/workflows/companion-parent.yaml', `name: companion-parent
initial_step: default-call
max_steps: 2
steps:
  - name: default-call
    kind: workflow_call
    call: ./companion-child.yaml
    rules:
      - condition: ok
        next: explicit-call
  - name: explicit-call
    kind: workflow_call
    call: ./companion-child.yaml
    args:
      reviewers:
        fixed: [arg-reviewer]
        pool: [pool-reviewer]
        moderator: mod-reviewer
    rules:
      - condition: ok
        next: COMPLETE
`);
    writeFixture('.takt/workflows/companion-child.yaml', `name: companion-child
subworkflow:
  callable: true
  params:
    reviewers:
      type: companion_ref[]
      default: [default-reviewer]
  returns: [ok]
initial_step: child-work
max_steps: 1
steps:
  - name: child-work
    instruction: Complete the child work.
    companion:
      $param: reviewers
    rules:
      - condition: done
        return: ok
`);
    writeFixture('.takt/facets/instructions/companion-instruction.md', 'COMPANION_INSTRUCTION\n');
    for (const companion of ['default-reviewer', 'arg-reviewer', 'pool-reviewer', 'mod-reviewer']) {
      writeFixture(`.takt/companions/${companion}.yaml`, `name: ${companion}
description: ${companion} definition
instruction: companion-instruction
`);
    }

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'companion-parent', 'project'),
      now: () => fixedTime,
    });
    expect(plan.files.filter((file) => dirname(file.relativePath) === 'companions')).toHaveLength(4);
    await materializeWorkflowMakerArtifact(plan);
    rmSync(join(projectDir, '.takt', 'workflows'), { recursive: true, force: true });
    rmSync(join(projectDir, '.takt', 'companions'), { recursive: true, force: true });
    rmSync(join(projectDir, '.takt', 'facets'), { recursive: true, force: true });

    const loaded = loadWorkflowFromFile(plan.rootWorkflowPath, projectDir, {
      resourceRoot: plan.artifactRoot,
    });
    const [defaultCall, explicitCall] = loaded.steps;
    if (defaultCall?.kind !== 'workflow_call' || explicitCall?.kind !== 'workflow_call') {
      throw new Error('Expected workflow_call steps');
    }
    const parentContext = { sourcePath: plan.rootWorkflowPath, resourceRoot: plan.artifactRoot };
    const defaultChild = resolveWorkflowCallTarget(
      loaded,
      defaultCall,
      projectDir,
      plan.artifactRoot,
      parentContext,
    );
    const explicitChild = resolveWorkflowCallTarget(
      loaded,
      explicitCall,
      projectDir,
      plan.artifactRoot,
      parentContext,
    );
    if (!defaultChild || !explicitChild) throw new Error('Expected artifact child workflows');
    expect(findAgentWorkflowStep(defaultChild, 'child-work').companion).toEqual({
      fixed: ['default-reviewer'],
      pool: [],
    });
    expect(findAgentWorkflowStep(explicitChild, 'child-work').companion).toEqual({
      fixed: ['arg-reviewer'],
      pool: ['pool-reviewer'],
      moderator: 'mod-reviewer',
    });
    expect(defaultChild.companions?.['default-reviewer']?.instruction).toBe('COMPANION_INSTRUCTION\n');
    expect(explicitChild.companions?.['mod-reviewer']?.instruction).toBe('COMPANION_INSTRUCTION\n');
  });

  it('distinguishes omitted and own prototype-named workflow-call arguments', async () => {
    const rootPath = writeFixture('.takt/workflows/prototype-param-parent.yaml', `name: prototype-param-parent
initial_step: default-child
max_steps: 2
steps:
  - name: default-child
    kind: workflow_call
    call: ./prototype-param-child.yaml
    args: {}
    rules:
      - condition: ok
        next: explicit-child
  - name: explicit-child
    kind: workflow_call
    call: ./prototype-param-child.yaml
    args:
      toString: explicit-guidance
    rules:
      - condition: ok
        next: COMPLETE
`);
    writeFixture('.takt/workflows/prototype-param-child.yaml', `name: prototype-param-child
instructions:
  default-guidance: ../facets/instructions/default-guidance.md
  explicit-guidance: ../facets/instructions/explicit-guidance.md
subworkflow:
  callable: true
  params:
    toString:
      type: facet_ref
      facet_kind: instruction
      default: default-guidance
  returns: [ok]
initial_step: work
max_steps: 1
steps:
  - name: work
    instruction:
      $param: toString
    rules:
      - condition: done
        return: ok
`);
    writeFixture('.takt/facets/instructions/default-guidance.md', 'DEFAULT_GUIDANCE\n');
    writeFixture('.takt/facets/instructions/explicit-guidance.md', 'EXPLICIT_GUIDANCE\n');

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'prototype-param-parent', 'project'),
      now: () => fixedTime,
    });
    await materializeWorkflowMakerArtifact(plan);
    rmSync(join(projectDir, '.takt', 'workflows'), { recursive: true, force: true });
    rmSync(join(projectDir, '.takt', 'facets'), { recursive: true, force: true });

    const loaded = loadWorkflowFromFile(plan.rootWorkflowPath, projectDir, {
      resourceRoot: plan.artifactRoot,
    });
    const [defaultCall, explicitCall] = loaded.steps;
    if (defaultCall?.kind !== 'workflow_call' || explicitCall?.kind !== 'workflow_call') {
      throw new Error('Expected workflow_call steps');
    }
    const context = { sourcePath: plan.rootWorkflowPath, resourceRoot: plan.artifactRoot };
    const defaultChild = resolveWorkflowCallTarget(
      loaded,
      defaultCall,
      projectDir,
      plan.artifactRoot,
      context,
    );
    const explicitChild = resolveWorkflowCallTarget(
      loaded,
      explicitCall,
      projectDir,
      plan.artifactRoot,
      context,
    );
    if (!defaultChild || !explicitChild) throw new Error('Expected artifact child workflows');
    expect(findAgentWorkflowStep(defaultChild, 'work').instruction).toBe('DEFAULT_GUIDANCE\n');
    expect(findAgentWorkflowStep(explicitChild, 'work').instruction).toBe('EXPLICIT_GUIDANCE\n');
  });

  it('does not synthesize a prototype-named typed step-fragment argument', async () => {
    const rootPath = writeFixture('.takt/workflows/prototype-fragment-parent.yaml', `name: prototype-fragment-parent
initial_step: work
max_steps: 1
steps:
  - uses: prototype-param-step
    with: {}
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFixture('.takt/steps/prototype-param-step.yaml', `params:
  toString:
    type: facet_ref
    facet_kind: instruction
name: work
instruction:
  $param: toString
`);

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'prototype-fragment-parent', 'project'),
      now: () => fixedTime,
    });
    const copiedRoot = parseYaml(plan.files.find(
      (file) => file.relativePath === join('workflows', 'prototype-fragment-parent.yaml'),
    )?.content ?? '') as { steps?: Array<{ with?: Record<string, unknown> }> };
    expect(copiedRoot.steps?.[0]?.with).toEqual({});
    expect(Object.hasOwn(copiedRoot.steps?.[0]?.with ?? {}, 'toString')).toBe(false);
  });

  it('preserves child-local aliases in typed defaults and explicit workflow_call arguments', async () => {
    const rootPath = writeFixture('.takt/workflows/typed-parent.yaml', `name: typed-parent
initial_step: default-call
max_steps: 2
steps:
  - name: default-call
    kind: workflow_call
    call: ./typed-child.yaml
    rules:
      - condition: ok
        next: explicit-call
  - name: explicit-call
    kind: workflow_call
    call: ./typed-child.yaml
    args:
      worker: explicit-worker
      guidance: [explicit-guidance]
      reviewers: explicit-reviewers
    rules:
      - condition: ok
        next: COMPLETE
`);
    writeFixture('.takt/workflows/typed-child.yaml', `name: typed-child
personas:
  default-worker: ../facets/personas/default-worker-source.md
  explicit-worker: ../facets/personas/explicit-worker-source.md
knowledge:
  default-guidance: ../facets/knowledge/default-guidance-source.md
  explicit-guidance: ../facets/knowledge/explicit-guidance-source.md
facet_pools:
  default-reviewers:
    knowledge:
      pool-default-guidance: ../facets/knowledge/default-guidance-source.md
    candidates:
      - id: default
        description: Default reviewer
        knowledge: pool-default-guidance
  explicit-reviewers:
    knowledge:
      pool-explicit-guidance: ../facets/knowledge/explicit-guidance-source.md
    candidates:
      - id: explicit
        description: Explicit reviewer
        knowledge: pool-explicit-guidance
subworkflow:
  callable: true
  params:
    worker:
      type: facet_ref
      facet_kind: persona
      default: default-worker
    guidance:
      type: facet_ref[]
      facet_kind: knowledge
      default: [default-guidance]
    reviewers:
      type: facet_pool_ref
      default: default-reviewers
  returns: [ok]
initial_step: child-work
max_steps: 1
steps:
  - name: child-work
    persona:
      $param: worker
    knowledge:
      $param: guidance
    instruction: Complete the child work.
    dynamic_facets:
      pool:
        $param: reviewers
    rules:
      - condition: done
        return: ok
`);
    for (const [kind, name, content] of [
      ['personas', 'default-worker-source', 'DEFAULT_WORKER'],
      ['personas', 'explicit-worker-source', 'EXPLICIT_WORKER'],
      ['knowledge', 'default-guidance-source', 'DEFAULT_GUIDANCE'],
      ['knowledge', 'explicit-guidance-source', 'EXPLICIT_GUIDANCE'],
    ] as const) {
      writeFixture(`.takt/facets/${kind}/${name}.md`, `${content}\n`);
    }

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'typed-parent', 'project'),
      now: () => fixedTime,
    });
    await materializeWorkflowMakerArtifact(plan);
    rmSync(join(projectDir, '.takt', 'workflows'), { recursive: true, force: true });
    rmSync(join(projectDir, '.takt', 'facets'), { recursive: true, force: true });

    const loaded = loadWorkflowFromFile(plan.rootWorkflowPath, projectDir, {
      resourceRoot: plan.artifactRoot,
    });
    const [defaultCall, explicitCall] = loaded.steps;
    if (defaultCall?.kind !== 'workflow_call' || explicitCall?.kind !== 'workflow_call') {
      throw new Error('Expected workflow_call steps');
    }
    const parentContext = { sourcePath: plan.rootWorkflowPath, resourceRoot: plan.artifactRoot };
    const defaultChild = resolveWorkflowCallTarget(
      loaded,
      defaultCall,
      projectDir,
      plan.artifactRoot,
      parentContext,
    );
    const explicitChild = resolveWorkflowCallTarget(
      loaded,
      explicitCall,
      projectDir,
      plan.artifactRoot,
      parentContext,
    );
    if (!defaultChild || !explicitChild) throw new Error('Expected artifact child workflows');
    const defaultWork = findAgentWorkflowStep(defaultChild, 'child-work');
    const explicitWork = findAgentWorkflowStep(explicitChild, 'child-work');
    expect(readFileSync(defaultWork.personaPath!, 'utf-8')).toBe('DEFAULT_WORKER\n');
    expect(defaultWork.knowledgeContents?.map((entry) => entry.content)).toContain('DEFAULT_GUIDANCE\n');
    expect(defaultWork.dynamicFacets?.pool).toBe('default-reviewers');
    expect(readFileSync(explicitWork.personaPath!, 'utf-8')).toBe('EXPLICIT_WORKER\n');
    expect(explicitWork.knowledgeContents?.map((entry) => entry.content)).toContain('EXPLICIT_GUIDANCE\n');
    expect(explicitWork.dynamicFacets?.pool).toBe('explicit-reviewers');
  });

  it('keeps colliding capability resources distinct and deduplicates repeated canonical references', async () => {
    const rootPath = writeFixture('.takt/workflows/capability-collision.yaml', `name: capability-collision
capabilities: [readonly, "@other/pkg/readonly"]
initial_step: first
max_steps: 2
steps:
  - name: first
    instruction: Run first.
    capabilities: readonly
  - name: second
    instruction: Run second.
    capabilities: [readonly, "@other/pkg/readonly"]
`);
    writeFixture('.takt/provider-options/readonly.yaml', 'claude:\n  allowed_tools: [Read]\n');
    writeConfigFixture(
      'repertoire/@other/pkg/provider-options/readonly.yaml',
      'codex:\n  network_access: true\n',
    );

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'capability-collision', 'project'),
      now: () => fixedTime,
    });
    const capabilityFiles = plan.files.filter((file) => dirname(file.relativePath) === 'provider-options');
    expect(capabilityFiles).toHaveLength(2);
    expect(new Set(capabilityFiles.map((file) => basename(file.relativePath)))).toHaveLength(2);
    const copiedRoot = parseYaml(plan.files.find(
      (file) => file.relativePath === join('workflows', 'capability-collision.yaml'),
    )?.content ?? '') as { capabilities?: string[]; steps?: Array<{ capabilities?: string | string[] }> };
    expect(copiedRoot.capabilities?.[0]).toBe(copiedRoot.steps?.[0]?.capabilities);
    expect(copiedRoot.capabilities?.[1]).not.toBe(copiedRoot.capabilities?.[0]);
    expect(copiedRoot.steps?.[1]?.capabilities).toEqual(copiedRoot.capabilities);

    await materializeWorkflowMakerArtifact(plan);
    rmSync(join(projectDir, '.takt', 'workflows'), { recursive: true, force: true });
    rmSync(join(projectDir, '.takt', 'provider-options'), { recursive: true, force: true });
    rmSync(join(configDir, 'repertoire', '@other', 'pkg'), { recursive: true, force: true });
    const loaded = loadWorkflowFromFile(plan.rootWorkflowPath, projectDir, {
      resourceRoot: plan.artifactRoot,
    });
    expect(findAgentWorkflowStep(loaded, 'second').capabilityProviderOptions).toEqual(expect.objectContaining({
      claude: expect.objectContaining({ allowedTools: ['Read'] }),
      codex: expect.objectContaining({ networkAccess: true }),
    }));
  });

  it('loads an artifact capability that has the same name as a builtin capability', async () => {
    const rootPath = writeFixture('.takt/workflows/artifact-edit.yaml', `name: artifact-edit
capabilities: edit
initial_step: work
max_steps: 1
steps:
  - name: work
    instruction: Work directly.
`);
    writeFixture('.takt/provider-options/edit.yaml', 'codex:\n  network_access: false\n');

    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'artifact-edit', 'project'),
      now: () => fixedTime,
    });
    await materializeWorkflowMakerArtifact(plan);
    rmSync(join(projectDir, '.takt', 'workflows'), { recursive: true, force: true });
    rmSync(join(projectDir, '.takt', 'provider-options'), { recursive: true, force: true });

    const loaded = loadWorkflowFromFile(plan.rootWorkflowPath, projectDir, {
      resourceRoot: plan.artifactRoot,
    });
    expect(findAgentWorkflowStep(loaded, 'work').capabilityProviderOptions?.codex?.networkAccess)
      .toBe(false);
  });

  it.each([
    ['missing companion', 'companion: [missing-reviewer]', /missing-reviewer/],
    ['escaping capability path', 'capabilities: ../../outside.yaml', /inside the workflow directory|outside/],
    ['missing scoped facet', 'persona: "@other/pkg/missing-reviewer"', /missing-reviewer/],
  ] as const)('rejects an unsafe or unresolved %s before writing', async (_case, field, expected) => {
    const rootPath = writeFixture('.takt/workflows/rejected-dependency.yaml', `name: rejected-dependency
initial_step: work
max_steps: 1
steps:
  - name: work
    instruction: Do work.
    ${field}
`);
    writeFixture('outside.yaml', 'claude:\n  allowed_tools: [Read]\n');

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'rejected-dependency', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(expected);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('rejects symlinked and cyclic provider-options dependencies before writing', async () => {
    const rootPath = writeFixture('.takt/workflows/provider-options-boundary.yaml', `name: provider-options-boundary
initial_step: work
max_steps: 1
steps:
  - name: work
    instruction: Do work.
    capabilities: linked
`);
    const outside = writeFixture('outside-provider-options.yaml', 'claude:\n  allowed_tools: [Read]\n');
    const link = join(projectDir, '.takt', 'provider-options', 'linked.yaml');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link);

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'provider-options-boundary', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/candidate directory|symlink/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);

    rmSync(link);
    writeFixture('.takt/provider-options/linked.yaml', 'extends: cycle-b\n');
    writeFixture('.takt/provider-options/cycle-b.yaml', 'extends: linked\n');
    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'provider-options-boundary', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/dependency cycle|circular reference/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);

    writeFileSync(link, 'claude:\n  effort: high\n', 'utf-8');
    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'provider-options-boundary', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/not a capability leaf/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('rejects a symlinked scoped facet before writing', async () => {
    const rootPath = writeFixture('.takt/workflows/scoped-symlink.yaml', `name: scoped-symlink
initial_step: work
max_steps: 1
steps:
  - name: work
    persona: "@other/pkg/reviewer"
    instruction: Do work.
`);
    const outside = writeConfigFixture('outside-persona.md', 'OUTSIDE\n');
    const link = join(configDir, 'repertoire', '@other', 'pkg', 'facets', 'personas', 'reviewer.md');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link);

    await expect(planWorkflowMakerArtifact({
      projectDir,
      base: existingBase(rootPath, 'scoped-symlink', 'project'),
      now: () => fixedTime,
    })).rejects.toThrow(/symlink|candidate directory/);
    expect(existsSync(join(projectDir, '.takt', 'make'))).toBe(false);
  });

  it('keeps the root and earlier files when materialization fails partway through', async () => {
    const plan = await planWorkflowMakerArtifact({
      projectDir,
      base: { kind: 'new', name: 'partial' },
      now: () => fixedTime,
    });
    const failingPlan = {
      ...plan,
      files: [
        ...plan.files,
        { relativePath: 'steps', content: 'cannot replace a directory' },
      ],
    };

    await expect(materializeWorkflowMakerArtifact(failingPlan)).rejects.toThrow();
    expect(existsSync(plan.artifactRoot)).toBe(true);
    expect(existsSync(join(plan.artifactRoot, 'workflows', 'partial.yaml'))).toBe(true);
  });
});
