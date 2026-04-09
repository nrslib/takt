import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectWorkflowFile } from '../infra/config/loaders/workflowDoctor.js';
import { loadPieceFromFile } from '../infra/config/loaders/pieceParser.js';
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

describe('workflow doctor', () => {
  let projectDir: string;
  const previousConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-workflow-doctor-'));
    process.env.TAKT_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'takt-workflow-doctor-global-'));
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
      return;
    }
    process.env.TAKT_CONFIG_DIR = previousConfigDir;
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

  it('reports missing refs for parallel sub-movements', () => {
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

    const config = loadPieceFromFile(filePath, projectDir);

    expect(config.movements[0]?.outputContracts?.[0]).toMatchObject({
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
    writeWorkflow(projectDir, '.takt/pieces/broken.yaml', `name: broken
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
