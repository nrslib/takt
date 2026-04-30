import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { inspectWorkflowFile, resolveWorkflowDoctorTargets } from '../infra/config/loaders/workflowDoctor.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import * as workflowResolver from '../infra/config/loaders/workflowResolver.js';
import { doctorWorkflowCommand } from '../features/workflowAuthoring/doctor.js';

const mockSuccess = vi.fn();
const mockWarn = vi.fn();
const mockError = vi.fn();

vi.mock('../shared/ui/index.js', () => ({
  success: (...args: unknown[]) => mockSuccess(...args),
  warn: (...args: unknown[]) => mockWarn(...args),
  error: (...args: unknown[]) => mockError(...args),
}));

function writeWorkflow(projectDir: string, relativePath: string, content: string): string {
  const filePath = join(projectDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

interface WorktreeRootCase {
  name: string;
  rootDirRelativePath: string;
  configContent?: string;
}

const worktreeRootCases: WorktreeRootCase[] = [
  {
    name: 'project .takt/worktrees root',
    rootDirRelativePath: '.takt/worktrees',
  },
  {
    name: 'sibling takt-worktrees root',
    rootDirRelativePath: '../takt-worktrees',
  },
  {
    name: 'configured global worktree_dir root',
    rootDirRelativePath: 'custom-worktrees',
    configContent: 'worktree_dir: custom-worktrees\n',
  },
];

function writeConfigForCase(rootCase: WorktreeRootCase): void {
  if (!rootCase.configContent) {
    return;
  }

  writeWorkflow(process.env.TAKT_CONFIG_DIR!, 'config.yaml', rootCase.configContent);
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
}

describe('workflow doctor', () => {
  let projectDir: string;
  const previousConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-workflow-doctor-'));
    process.env.TAKT_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'takt-workflow-doctor-global-'));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    mockSuccess.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    if (process.env.TAKT_CONFIG_DIR) {
      rmSync(process.env.TAKT_CONFIG_DIR, { recursive: true, force: true });
    }
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
      invalidateGlobalConfigCache();
      invalidateAllResolvedConfigCache();
      return;
    }
    process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('reports no diagnostics for a valid workflow file', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/valid.yaml', `name: valid
max_steps: 10
initial_step: step1
steps:
  - name: step1
    rules:
      - condition: done
        next: COMPLETE
`);

    const report = inspectWorkflowFile(filePath, projectDir);

    expect(report.diagnostics).toEqual([]);
  });

  it('reports missing resource references', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/missing-refs.yaml', `name: missing-refs
max_steps: 10
initial_step: step1
steps:
  - name: step1
    persona: missing-persona
    instruction: missing-instruction
    output_contracts:
      report:
        - name: summary.md
          format: missing-format
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain('step "step1" persona references missing resource "missing-persona"');
    expect(messages).toContain('step "step1" instruction references missing resource "missing-instruction"');
    expect(messages).toContain('step "step1" output_contract format references missing resource "missing-format"');
  });

  it('reports missing team_leader persona references', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/missing-team-leader-refs.yaml', `name: missing-team-leader-refs
max_steps: 10
initial_step: step1
steps:
  - name: step1
    team_leader:
      persona: missing-team-leader
      part_persona: missing-worker
    instruction: decompose
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain('step "step1" team_leader persona references missing resource "missing-team-leader"');
    expect(messages).toContain('step "step1" team_leader part_persona references missing resource "missing-worker"');
  });

  it('reports missing loop monitor judge references', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/missing-loop-monitor-refs.yaml', `name: missing-loop-monitor-refs
max_steps: 10
initial_step: step1
loop_monitors:
  - cycle: [step1, step2]
    threshold: 2
    judge:
      persona: missing-judge
      instruction: missing-judge-instruction
      rules:
        - condition: retry
          next: step1
steps:
  - name: step1
    rules:
      - condition: continue
        next: step2
  - name: step2
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain('loop monitor (step1 -> step2) persona references missing resource "missing-judge"');
    expect(messages).toContain('loop monitor (step1 -> step2) instruction references missing resource "missing-judge-instruction"');
  });

  it('reports missing refs for parallel substeps', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/missing-parallel-refs.yaml', `name: missing-parallel-refs
max_steps: 10
initial_step: step1
steps:
  - name: step1
    parallel:
      - name: part1
        persona: missing-part-persona
        instruction: missing-part-instruction
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain('step "step1"/part1 persona references missing resource "missing-part-persona"');
    expect(messages).toContain('step "step1"/part1 instruction references missing resource "missing-part-instruction"');
  });

  it('reports unknown next steps and unreachable steps', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/routing.yaml', `name: routing
max_steps: 10
initial_step: step1
steps:
  - name: step1
    rules:
      - condition: reroute
        next: missing-step
  - name: step2
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain('Step "step1" routes to unknown next step "missing-step"');
    expect(messages).toContain('Unreachable steps: step2');
  });

  it('treats steps reachable from loop monitor transitions as reachable', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/loop-monitor-reachability.yaml', `name: loop-monitor-reachability
max_steps: 10
initial_step: step1
loop_monitors:
  - cycle: [step1, step2]
    threshold: 2
    judge:
      rules:
        - condition: escape
          next: step3
steps:
  - name: step1
    rules:
      - condition: continue
        next: step2
  - name: step2
    rules:
      - condition: repeat
        next: step1
  - name: step3
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).not.toContain('Unreachable steps: step3');
  });

  it('reports missing initial_step target', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/initial.yaml', `name: initial
max_steps: 10
initial_step: missing
steps:
  - name: step1
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain('initial_step references missing step "missing"');
    expect(messages).toContain('Unreachable steps: step1');
  });

  it('reports unused section entries as warnings', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/unused.yaml', `name: unused
max_steps: 10
initial_step: step1
personas:
  unused-persona: ./facets/personas/unused-persona.md
instructions:
  used-step: ./facets/instructions/used-step.md
  unused-step: ./facets/instructions/unused-step.md
steps:
  - name: step1
    instruction: used-step
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(join(projectDir, '.takt/facets/personas'), { recursive: true });
    mkdirSync(join(projectDir, '.takt/facets/instructions'), { recursive: true });
    writeFileSync(join(projectDir, '.takt/facets/personas/unused-persona.md'), 'persona', 'utf-8');
    writeFileSync(join(projectDir, '.takt/facets/instructions/used-step.md'), 'instruction', 'utf-8');
    writeFileSync(join(projectDir, '.takt/facets/instructions/unused-step.md'), 'instruction', 'utf-8');

    const diagnostics = inspectWorkflowFile(filePath, projectDir).diagnostics;

    expect(diagnostics).toContainEqual({
      level: 'warning',
      message: 'Unused personas entry "unused-persona"',
    });
    expect(diagnostics).toContainEqual({
      level: 'warning',
      message: 'Unused instructions entry "unused-step"',
    });
  });

  it('accepts callable subworkflow defaults referenced via $param', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/callable-defaults.yaml', `name: callable-defaults
subworkflow:
  callable: true
  params:
    review_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
      default: [architecture]
    review_instruction:
      type: facet_ref
      facet_kind: instruction
      default: delegated-review
    review_report:
      type: facet_ref
      facet_kind: report_format
      default: summary
max_steps: 10
initial_step: review
knowledge:
  architecture: ./facets/knowledge/architecture.md
instructions:
  delegated-review: ./facets/instructions/delegated-review.md
report_formats:
  summary: ./facets/output-contracts/summary.md
steps:
  - name: review
    knowledge:
      $param: review_knowledge
    instruction:
      $param: review_instruction
    output_contracts:
      report:
        - name: summary.md
          format:
            $param: review_report
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(join(projectDir, '.takt/facets/knowledge'), { recursive: true });
    mkdirSync(join(projectDir, '.takt/facets/instructions'), { recursive: true });
    mkdirSync(join(projectDir, '.takt/facets/output-contracts'), { recursive: true });
    writeFileSync(join(projectDir, '.takt/facets/knowledge/architecture.md'), 'Architecture', 'utf-8');
    writeFileSync(join(projectDir, '.takt/facets/instructions/delegated-review.md'), 'Review', 'utf-8');
    writeFileSync(join(projectDir, '.takt/facets/output-contracts/summary.md'), '# Summary', 'utf-8');

    const diagnostics = inspectWorkflowFile(filePath, projectDir).diagnostics;

    expect(diagnostics).toEqual([]);
  });

  it('accepts scalar policy and knowledge defaults referenced via $param', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/callable-scalar-defaults.yaml', `name: callable-scalar-defaults
subworkflow:
  callable: true
  params:
    review_policy:
      type: facet_ref
      facet_kind: policy
      default: strict-review
    review_knowledge:
      type: facet_ref
      facet_kind: knowledge
      default: architecture
max_steps: 10
initial_step: review
policies:
  strict-review: ./facets/policies/strict-review.md
knowledge:
  architecture: ./facets/knowledge/architecture.md
steps:
  - name: review
    policy:
      $param: review_policy
    knowledge:
      $param: review_knowledge
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(join(projectDir, '.takt/facets/policies'), { recursive: true });
    mkdirSync(join(projectDir, '.takt/facets/knowledge'), { recursive: true });
    writeFileSync(join(projectDir, '.takt/facets/policies/strict-review.md'), 'Strict review', 'utf-8');
    writeFileSync(join(projectDir, '.takt/facets/knowledge/architecture.md'), 'Architecture', 'utf-8');

    const diagnostics = inspectWorkflowFile(filePath, projectDir).diagnostics;

    expect(diagnostics).toEqual([]);
  });

  it('reports callable default facet refs whose values do not match facet_kind', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/callable-invalid-default.yaml', `name: callable-invalid-default
subworkflow:
  callable: true
  params:
    review_knowledge:
      type: facet_ref
      facet_kind: knowledge
      default: strict-review
max_steps: 10
initial_step: review
policies:
  strict-review: ./facets/policies/strict-review.md
steps:
  - name: review
    knowledge:
      $param: review_knowledge
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(join(projectDir, '.takt/facets/policies'), { recursive: true });
    writeFileSync(join(projectDir, '.takt/facets/policies/strict-review.md'), 'Strict review', 'utf-8');

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain(
      'Workflow "callable-invalid-default.yaml" failed to load: workflow_call arg "review_knowledge" references unknown knowledge facet "strict-review"',
    );
  });

  it('allows doctor inspection for callable subworkflows with required params', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/callable-required-param.yaml', `name: callable-required-param
subworkflow:
  callable: true
  params:
    review_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
max_steps: 10
initial_step: review
steps:
  - name: review
    knowledge:
      $param: review_knowledge
    rules:
      - condition: done
        next: COMPLETE
`);

    const diagnostics = inspectWorkflowFile(filePath, projectDir).diagnostics;

    expect(diagnostics).toEqual([]);
  });

  it('reports unsupported nested workflow_call child return conditions for callable subworkflows with required params', () => {
    writeWorkflow(projectDir, '.takt/workflows/grandchild.yaml', `name: grandchild
subworkflow:
  callable: true
  returns: [ok]
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: Review
    rules:
      - condition: done
        return: ok
`);
    const filePath = writeWorkflow(projectDir, '.takt/workflows/child.yaml', `name: child
subworkflow:
  callable: true
  params:
    review_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
  returns: [ok]
initial_step: review
max_steps: 3
steps:
  - name: review
    knowledge:
      $param: review_knowledge
    rules:
      - condition: continue
        next: delegate-grandchild
  - name: delegate-grandchild
    kind: workflow_call
    call: grandchild
    rules:
      - condition: retry_plan
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain(
      'Workflow "child.yaml" failed to load: workflow_call step "delegate-grandchild" cannot route on unsupported child result "retry_plan"',
    );
  });

  it('reports unsupported workflow_call child return conditions', () => {
    writeWorkflow(projectDir, '.takt/workflows/child.yaml', `name: child
subworkflow:
  callable: true
  returns: [ok]
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: Review
    rules:
      - condition: done
        return: ok
`);
    const filePath = writeWorkflow(projectDir, '.takt/workflows/parent.yaml', `name: parent
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

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain(
      'Workflow "parent.yaml" failed to load: workflow_call step "delegate" cannot route on unsupported child result "retry_plan"',
    );
  });

  it('reports unsupported nested workflow_call child return conditions', () => {
    writeWorkflow(projectDir, '.takt/workflows/grandchild.yaml', `name: grandchild
subworkflow:
  callable: true
  returns: [ok]
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: reviewer
    instruction: Review
    rules:
      - condition: done
        return: ok
`);
    writeWorkflow(projectDir, '.takt/workflows/child.yaml', `name: child
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
    const filePath = writeWorkflow(projectDir, '.takt/workflows/parent.yaml', `name: parent
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

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toContain(
      'Workflow "parent.yaml" failed to load: workflow_call step "delegate-grandchild" cannot route on unsupported child result "retry_plan"',
    );
  });

  it('does not read path-based workflow_call children during doctor inspection', () => {
    writeFileSync(join(projectDir, 'secret.txt'), 'SECRET_DOCTOR_MARKER: [not yaml', 'utf-8');
    const filePath = writeWorkflow(projectDir, '.takt/workflows/parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ../../secret.txt
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).toEqual([]);
    expect(messages.join('\n')).not.toContain('SECRET_DOCTOR_MARKER');
  });

  it('does not warn for personas used by team_leader references', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/team-leader-used-personas.yaml', `name: team-leader-used-personas
max_steps: 10
initial_step: step1
personas:
  lead: ./facets/personas/lead.md
  worker: ./facets/personas/worker.md
steps:
  - name: step1
    team_leader:
      persona: lead
      part_persona: worker
    instruction: decompose
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(join(projectDir, '.takt/facets/personas'), { recursive: true });
    writeFileSync(join(projectDir, '.takt/facets/personas/lead.md'), 'lead persona', 'utf-8');
    writeFileSync(join(projectDir, '.takt/facets/personas/worker.md'), 'worker persona', 'utf-8');

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).not.toContain('Unused personas entry "lead"');
    expect(messages).not.toContain('Unused personas entry "worker"');
  });

  it('does not treat report.order as a missing output-contract ref', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/report-order-inline.yaml', `name: report-order-inline
max_steps: 10
initial_step: step1
report_formats:
  plan: ./facets/output-contracts/plan.md
steps:
  - name: step1
    output_contracts:
      report:
        - name: 00-plan.md
          format: plan
          order: Output to {report:00-plan.md} and overwrite if it already exists.
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(join(projectDir, '.takt/facets/output-contracts'), { recursive: true });
    writeFileSync(join(projectDir, '.takt/facets/output-contracts/plan.md'), '# Plan', 'utf-8');

    const messages = inspectWorkflowFile(filePath, projectDir).diagnostics.map((item) => item.message);

    expect(messages).not.toContain(expect.stringContaining('output_contract order references missing resource'));
  });

  it('loads report.order inline templates without resolving them as facet refs', () => {
    const filePath = writeWorkflow(projectDir, '.takt/workflows/report-order-loader.yaml', `name: report-order-loader
max_steps: 10
initial_step: step1
report_formats:
  plan: ./facets/output-contracts/plan.md
steps:
  - name: step1
    output_contracts:
      report:
        - name: 00-plan.md
          format: plan
          order: Output to {report:00-plan.md} file.
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(join(projectDir, '.takt/facets/output-contracts'), { recursive: true });
    writeFileSync(join(projectDir, '.takt/facets/output-contracts/plan.md'), '# Plan', 'utf-8');

    const config = loadWorkflowFromFile(filePath, projectDir);

    expect(config.steps[0]?.outputContracts?.[0]).toMatchObject({
      name: '00-plan.md',
      order: 'Output to {report:00-plan.md} file.',
    });
  });

  it('validates all project workflow files when no targets are given', async () => {
    writeWorkflow(projectDir, '.takt/workflows/valid.yaml', `name: valid
max_steps: 10
initial_step: step1
steps:
  - name: step1
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(projectDir, '.takt/workflows/broken.yaml', `name: broken
max_steps: 10
initial_step: step1
steps:
  - name: step1
    rules:
      - condition: done
        next: missing
`);

    await expect(doctorWorkflowCommand([], projectDir)).rejects.toThrow('Workflow validation failed');

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('valid.yaml'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('missing'));
  });

  it('inspects privileged builtin workflows without downgrading them to project trust', () => {
    const builtinPath = join(process.cwd(), 'builtins', 'ja', 'workflows', 'auto-improvement-loop.yaml');

    const report = inspectWorkflowFile(builtinPath, process.cwd());

    expect(report.diagnostics).toEqual([]);
  });

  it('resolves named builtin workflow targets without downgrading privileged builtin trust', async () => {
    await expect(doctorWorkflowCommand(['auto-improvement-loop'], process.cwd())).resolves.toBeUndefined();

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('auto-improvement-loop.yaml'));
    expect(mockError).not.toHaveBeenCalled();
  });

  it('rejects named builtin workflow targets when builtin workflows are disabled', async () => {
    writeFileSync(join(process.env.TAKT_CONFIG_DIR!, 'config.yaml'), 'enable_builtin_workflows: false\n', 'utf-8');
    invalidateGlobalConfigCache();

    await expect(doctorWorkflowCommand(['auto-improvement-loop'], process.cwd())).rejects.toThrow(
      'Workflow not found: auto-improvement-loop',
    );

    expect(mockSuccess).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it('rejects named builtin workflow targets when the builtin is individually disabled', async () => {
    writeFileSync(
      join(process.env.TAKT_CONFIG_DIR!, 'config.yaml'),
      'disabled_builtins:\n  - auto-improvement-loop\n',
      'utf-8',
    );
    invalidateGlobalConfigCache();

    await expect(doctorWorkflowCommand(['auto-improvement-loop'], process.cwd())).rejects.toThrow(
      'Workflow not found: auto-improvement-loop',
    );

    expect(mockSuccess).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it('resolves named builtin workflow targets from loader-side target resolution', () => {
    const [target] = resolveWorkflowDoctorTargets(['auto-improvement-loop'], process.cwd());

    expect(target).toMatchObject({
      filePath: expect.stringContaining('auto-improvement-loop.yaml'),
      source: 'builtin',
    });
  });

  it.each(worktreeRootCases)(
    'allows runtime.prepare for explicitly targeted worktree workflow paths in $name',
    async (rootCase) => {
      writeConfigForCase(rootCase);
      const { rootDirRelativePath } = rootCase;
      const rootDir = join(projectDir, rootDirRelativePath);
      const worktreeDir = join(rootDir, 'feature-branch');
      const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'prepare.yaml');
      mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
      writeFileSync(worktreeWorkflowPath, `name: prepare
max_steps: 10
initial_step: review
workflow_config:
  runtime:
    prepare:
      - node
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

      await expect(
        doctorWorkflowCommand([relative(projectDir, worktreeWorkflowPath)], projectDir),
      ).resolves.toBeUndefined();

      expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('prepare.yaml'));
      expect(mockError).not.toHaveBeenCalled();
    },
  );

  it.each(worktreeRootCases)(
    'allows allow_git_commit for explicitly targeted worktree workflow paths in $name',
    async (rootCase) => {
      writeConfigForCase(rootCase);
      const { rootDirRelativePath } = rootCase;
      const rootDir = join(projectDir, rootDirRelativePath);
      const worktreeDir = join(rootDir, 'feature-branch');
      const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'commit.yaml');
      mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
      writeFileSync(worktreeWorkflowPath, `name: commit
max_steps: 10
initial_step: review
steps:
  - name: review
    allow_git_commit: true
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

      await expect(
        doctorWorkflowCommand([relative(projectDir, worktreeWorkflowPath)], projectDir),
      ).resolves.toBeUndefined();

      expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('commit.yaml'));
      expect(mockError).not.toHaveBeenCalled();
    },
  );

  it.each(worktreeRootCases)(
    'passes derived worktree lookupCwd into workflow_call contract validation for path targets in $name',
    async (rootCase) => {
      writeConfigForCase(rootCase);
      const validateContractsSpy = vi.spyOn(workflowResolver, 'validateWorkflowCallContracts');
      const { rootDirRelativePath } = rootCase;
      const rootDir = join(projectDir, rootDirRelativePath);
      const worktreeDir = join(rootDir, 'feature-branch');
      const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');

      writeWorkflow(projectDir, '.takt/workflows/child.yaml', `name: child
subworkflow:
  callable: true
initial_step: review
max_steps: 3
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
      mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
      writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: COMPLETE
        next: COMPLETE
`, 'utf-8');

      try {
        await expect(
          doctorWorkflowCommand([relative(projectDir, worktreeWorkflowPath)], projectDir),
        ).resolves.toBeUndefined();

        expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('parent.yaml'));
        expect(validateContractsSpy).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'parent' }),
          projectDir,
          worktreeDir,
          { allowPathBasedCalls: false },
        );
      } finally {
        validateContractsSpy.mockRestore();
      }
    },
  );

  it.each(worktreeRootCases)(
    'derives worktree lookupCwd from loader-side target resolution for path targets in $name',
    (rootCase) => {
      writeConfigForCase(rootCase);
      const { rootDirRelativePath } = rootCase;
      const rootDir = join(projectDir, rootDirRelativePath);
      const worktreeDir = join(rootDir, 'feature-branch');
      const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');

      mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
      writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    rules:
      - condition: COMPLETE
        next: COMPLETE
`, 'utf-8');

      const [target] = resolveWorkflowDoctorTargets([relative(projectDir, worktreeWorkflowPath)], projectDir);

      expect(target).toEqual({
        filePath: worktreeWorkflowPath,
        lookupCwd: worktreeDir,
      });
    },
  );

  it('passes absolute configured worktree_dir into workflow_call contract validation for path targets', async () => {
    const configuredRoot = mkdtempSync(join(tmpdir(), 'takt-doctor-worktrees-'));
    const validateContractsSpy = vi.spyOn(workflowResolver, 'validateWorkflowCallContracts');

    writeWorkflow(process.env.TAKT_CONFIG_DIR!, 'config.yaml', `worktree_dir: ${configuredRoot}\n`);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const worktreeDir = join(configuredRoot, 'feature-branch');
    const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');

    writeWorkflow(projectDir, '.takt/workflows/child.yaml', `name: child
subworkflow:
  callable: true
initial_step: review
max_steps: 3
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
    writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: COMPLETE
        next: COMPLETE
`, 'utf-8');

    try {
      await expect(
        doctorWorkflowCommand([relative(projectDir, worktreeWorkflowPath)], projectDir),
      ).resolves.toBeUndefined();

      expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('parent.yaml'));
      expect(validateContractsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'parent' }),
        projectDir,
        worktreeDir,
        { allowPathBasedCalls: false },
      );
    } finally {
      validateContractsSpy.mockRestore();
      rmSync(configuredRoot, { recursive: true, force: true });
    }
  });

  it('resolves named workflow targets and validates them', async () => {
    writeWorkflow(projectDir, '.takt/workflows/named.yaml', `name: named
max_steps: 10
initial_step: step1
steps:
  - name: step1
    rules:
      - condition: done
        next: COMPLETE
`);

    await doctorWorkflowCommand(['named'], projectDir);

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('named.yaml'));
  });
});
