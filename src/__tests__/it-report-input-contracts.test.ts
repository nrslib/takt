import { WorkflowStepRawSchema, LoopMonitorJudgeSchema } from '../core/models/index.js';
import { doctorWorkflowCommand } from '../features/workflowAuthoring/doctor.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { resolveDeclaredReportInputs } from '../core/workflow/instruction/declared-report-inputs.js';
import { WorkflowCallInvocationIndex } from '../core/workflow/workflow-call-invocation-index.js';
import { WorkflowStepParticipationIndex } from '../core/workflow/workflow-step-participation-index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';
import type { WorkflowConfig } from '../core/models/types.js';
import { getBuiltinWorkflowsDir } from '../infra/config/paths.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { ReportInstructionBuilder } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';
import { ReportExecutionStore } from '../core/workflow/report-execution-store.js';
import { readFileSync, statSync } from 'node:fs';
import { buildWorkflowStepParticipationIdentity } from '../core/workflow/workflow-step-participation-index.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import { reportInputNames } from '../core/workflow/report-input-contract.js';
import { reportInputEntries } from '../core/models/workflow-report-input.js';
import type { WorkflowCallResolver } from '../core/workflow/types.js';
import { buildWorkflowCallNamespaceSegment } from '../core/workflow/workflow-call-namespace.js';

describe('builtin implementation report input contracts', () => {
  let root: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-report-contracts-'));
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = join(root, 'global');
    mkdirSync(join(root, '.takt'));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = originalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  for (const language of ['ja', 'en'] as const) {
    it('passes the actual parent decision and its history into the builtin fix plan (' + language + ')', () => {
      writeFileSync(join(root, '.takt', 'config.yaml'), `language: ${language}\n`);
      const workflow = loadWorkflowFromFile(join(getBuiltinWorkflowsDir(language), 'peer-review.yaml'), root);
      const call = workflow.steps.find((step) => step.name === 'remediation')!;
      expect(call.kind).toBe('workflow_call');
      if (call.kind !== 'workflow_call') throw new Error('Expected remediation call');
      const child = resolveWorkflowCallTarget(workflow, call, root)!;
      const planner = child.steps.find((step) => step.name === 'fix-plan')!;
      const state = createInitialState(workflow, { projectCwd: root });
      const participation = new WorkflowStepParticipationIndex(new Map());
      const store = new ReportExecutionStore(root);
      const identity = buildWorkflowStepParticipationIdentity(getWorkflowReference(workflow), 'review-adjudication', []);
      for (const content of ['PRIOR-DECISION-ONLY', 'CURRENT-DECISION-ONLY']) {
        const id = store.begin(identity, 'review-adjudication', root, ['review-resolution.md']);
        writeFileSync(join(root, 'review-resolution.md'), content);
        store.capture(root, 'review-resolution.md', content);
        store.finish(id, true);
      }
      participation.record(workflow, 'review-adjudication', [], ['review-resolution.md']);
      state.stepOutputs.set('review-adjudication', { persona: 'review-adjudication', status: 'done', content: 'done', timestamp: new Date(0) });
      const inputs = resolveDeclaredReportInputs(call, {
        workflow, state, projectCwd: root, lookupCwd: root, reportDir: root, resumeStackPrefix: [],
        sharedRuntime: { startedAtMs: 0, reportExecutions: store, workflowStepParticipationIndex: participation,
          workflowCallInvocationEvidence: { kind: 'exact', index: new WorkflowCallInvocationIndex(new Map()) } },
      })!;
      const prepared = new InstructionBuilder(planner, makeInstructionContext({ reportDir: root, language, declaredReportInputs: [inputs] })).prepare();
      expect(prepared.text).toContain('CURRENT-DECISION-ONLY');
      expect(prepared.text).not.toContain('PRIOR-DECISION-ONLY');
      expect(prepared.text).toContain(`execution=${inputs.reports[0]!.execution!.id}`);
      expect(prepared.text).toContain('producer start=3; producer completion=4');
      const history = prepared.injectedReports.find((report) => report.kind === 'history')!;
      expect(history.reference).toBe('review-resolution.md');
      expect(history.content).toContain(store.executions(identity)[0]!.id);
      const pinned = join(root, store.executions(identity)[0]!.reports['review-resolution.md']!);
      expect(history.content).toContain(pinned);
      expect(readFileSync(pinned, 'utf8')).toBe('PRIOR-DECISION-ONLY');
    });

    it('validates migrated builtin producer names and monitor cycles (' + language + ')', () => {
      writeFileSync(join(root, '.takt', 'config.yaml'), `language: ${language}\n`);
      const resolver: WorkflowCallResolver = ({ parentWorkflow, step }) => resolveWorkflowCallTarget(parentWorkflow, step, root);
      const context = { projectCwd: root, lookupCwd: root, workflowCallResolver: resolver };
      for (const name of ['peer-review', 'review-fix-backend', 'review-fix-backend-cqrs', 'review-fix-dual', 'review-fix-dual-cqrs', 'review-fix-frontend', 'development-remediation', 'development-remediation-dynamic', 'review-remediation', 'mini-core', 'workflow-maker']) {
        const workflow = loadWorkflowFromFile(join(getBuiltinWorkflowsDir(language), `${name}.yaml`), root);
        for (const step of workflow.steps) expect(() => reportInputNames(workflow, step, context)).not.toThrow();
        for (const monitor of workflow.loopMonitors ?? []) {
          expect(reportInputEntries(monitor.judge.inputReports).length).toBeGreaterThan(0);
          for (const entry of reportInputEntries(monitor.judge.inputReports)) {
            expect(monitor.cycle).toContain(entry.fromStep);
            expect(entry.history?.previous).toBe(2);
          }
          expect(() => reportInputNames(workflow, { name: '_judge', inputReports: monitor.judge.inputReports }, context)).not.toThrow();
        }
      }
    });

    it.each(['default', 'simple', 'simple-mini', 'frontend-mini', 'maintenance', 'takt-default-team'])
      ('shares the evidence format between work and reports for %s (' + language + ')', (name) => {
        writeFileSync(join(root, '.takt', 'config.yaml'), `language: ${language}\n`);
        const workflow = loadWorkflowFromFile(join(getBuiltinWorkflowsDir(language), `${name}.yaml`), root);
        const workflows: WorkflowConfig[] = [];
        const pending = [workflow];
        const visited = new Set<string>();
        while (pending.length > 0) {
          const current = pending.pop()!;
          if (visited.has(current.name)) continue;
          visited.add(current.name);
          workflows.push(current);
          for (const step of current.steps) {
            if (step.kind !== 'workflow_call') continue;
            const child = resolveWorkflowCallTarget(current, step, root);
            expect(child).not.toBeNull();
            if (child) pending.push(child);
          }
        }
        const implementationSteps = workflows.flatMap((entry) => entry.steps)
          .filter((step) => step.outputContracts?.some((entry) => entry.name === 'implementation-report.md'));
        expect(implementationSteps.length).toBeGreaterThan(0);
        for (const step of implementationSteps) {
          const contract = step.outputContracts!.find((entry) => entry.name === 'implementation-report.md')!;
          expect(contract.format).toBeTruthy();
          expect(contract.order).toBeTruthy();
          const context = makeInstructionContext({
            cwd: root, projectCwd: root, language, reportDir: join(root, 'reports'),
            userInputs: ['Withdraw the obsolete obligation.'],
          });
          const prepared = new InstructionBuilder(step, context).prepare();
          const report = new ReportInstructionBuilder(step, {
            cwd: root, language, reportDir: context.reportDir!, stepIteration: 1,
            targetFile: 'implementation-report.md', reportInputs: prepared.reportInputs,
          }).build();
          expect(prepared.text).toContain(contract.format);
          expect(prepared.text).toContain(contract.order!);
          expect(report).toContain(contract.format);
          expect(report).toContain(contract.order!);
          expect(report).toContain(JSON.stringify(context.userInputs));
        }
      });
  }
});

describe('multiple report input declarations', () => {
  let root: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-multiple-report-inputs-'));
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = join(root, 'global');
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = originalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  function declaration(fromStep: string, reports: string[] | 'all', optional = false) {
    return { from_step: fromStep, reports, ...(optional ? { optional_if_unrun: true } : {}) };
  }

  function rawWorkflow(inputs: unknown) {
    return {
      name: 'multiple-inputs', initial_step: 'remediation', max_steps: 10,
      steps: [
        { name: 'remediation', output_contracts: { report: [{ name: 'fix-plan.md', format: '# Plan\nWrite the plan.' }] },
          rules: [{ condition: 'done', next: 'adjudicate' }] },
        { name: 'adjudicate', output_contracts: { report: [{ name: 'resolution.md', format: '# Resolution\nWrite the resolution.' }] },
          rules: [{ condition: 'done', next: 'consumer' }] },
        { name: 'consumer', input_reports: inputs,
          instruction: 'PLAN-BEGIN\n{report:fix-plan.md}\nPLAN-END\nRESOLUTION-BEGIN\n{report:resolution.md}\nRESOLUTION-END',
          rules: [{ condition: 'done', next: 'COMPLETE' }] },
      ],
    };
  }

  function saveWorkflow(raw: unknown): string {
    const path = join(root, 'workflow.yaml');
    writeFileSync(path, JSON.stringify(raw));
    return path;
  }

  function runtime(inputs: unknown, executed: readonly string[]) {
    const config = loadWorkflowFromFile(saveWorkflow(rawWorkflow(inputs)), root);
    const state = createInitialState(config, { projectCwd: root });
    const participation = new WorkflowStepParticipationIndex(new Map());
    for (const name of executed) {
      const file = name === 'remediation' ? 'fix-plan.md' : 'resolution.md';
      participation.record(config, name, [], [file]);
      state.stepOutputs.set(name, { persona: name, status: 'done', content: 'done', timestamp: new Date(0) });
      writeFileSync(join(root, file), `BODY-${name}`);
    }
    const consumer = config.steps.find((step) => step.name === 'consumer')!;
    const resolve = () => resolveDeclaredReportInputs(consumer, {
      workflow: config, state,
      sharedRuntime: {
        startedAtMs: 0,
        workflowCallInvocationEvidence: { kind: 'exact', index: new WorkflowCallInvocationIndex(new Map()) },
        workflowStepParticipationIndex: participation,
      },
      projectCwd: root, lookupCwd: root, reportDir: root, resumeStackPrefix: [],
    });
    return { consumer, resolve };
  }

  it.each(['agent', 'workflow_call', 'parallel child'] as const)('accepts array inputs with per-source history on a %s', (kind) => {
    const input = [
      { ...declaration('remediation', ['fix-plan.md']), history: { previous: 2 } },
      declaration('adjudicate', ['resolution.md'], true),
    ];
    const common = { name: 'consumer', input_reports: input, rules: [{ condition: 'done', next: 'COMPLETE' }] };
    const raw = kind === 'workflow_call'
      ? { ...common, kind: 'workflow_call', call: 'child', rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] }
      : kind === 'parallel child'
        ? { name: 'parallel', parallel: [common], rules: [{ condition: 'all("done")', next: 'COMPLETE' }] }
        : common;
    expect(WorkflowStepRawSchema.safeParse(raw).success).toBe(true);
    const normalized = loadWorkflowFromFile(saveWorkflow({ name: 'normalize-inputs', steps: [raw] }), root).steps[0]!;
    const target = kind === 'parallel child' && Array.isArray(normalized.parallel) ? normalized.parallel[0] : normalized;
    expect(target).toMatchObject({ inputReports: [
      { fromStep: 'remediation', reports: ['fix-plan.md'], history: { previous: 2 } },
      { fromStep: 'adjudicate', reports: ['resolution.md'], optionalIfUnrun: true },
    ] });
  });

  it.each([
    { kind: 'empty', inputs: [] },
    { kind: 'negative previous', inputs: [{ ...declaration('remediation', ['fix-plan.md']), history: { previous: -1 } }] },
    { kind: 'fractional previous', inputs: [{ ...declaration('remediation', ['fix-plan.md']), history: { previous: 1.5 } }] },
    { kind: 'unknown history key', inputs: [{ ...declaration('remediation', ['fix-plan.md']), history: { previous: 2, limit: 8000 } }] },
  ])
    ('rejects an invalid input array: $kind', ({ inputs }) => {
      expect(WorkflowStepRawSchema.safeParse({ name: 'consumer', input_reports: inputs }).success).toBe(false);
    });

  it('normalizes a single source with history and preserves the legacy single source', () => {
    for (const history of [undefined, { previous: 0 }, { previous: 2 }]) {
      const raw = declaration('remediation', ['fix-plan.md'], true);
      const config = loadWorkflowFromFile(saveWorkflow(rawWorkflow({ ...raw, ...(history ? { history } : {}) })), root);
      expect(config.steps[2]?.inputReports).toEqual({
        fromStep: 'remediation', reports: ['fix-plan.md'], optionalIfUnrun: true,
        ...(history ? { history } : {}),
      });
    }
  });

  it('passes both producer bodies into their own positions in the complete prompt', () => {
    const f = runtime([declaration('remediation', ['fix-plan.md']), declaration('adjudicate', ['resolution.md'])],
      ['remediation', 'adjudicate']);
    const text = new InstructionBuilder(f.consumer, makeInstructionContext({
      reportDir: root, declaredReportInputs: [f.resolve()!],
    })).prepare().text;
    expect(text).toContain('PLAN-BEGIN\nBODY-remediation\nPLAN-END');
    expect(text).toContain('RESOLUTION-BEGIN\nBODY-adjudicate\nRESOLUTION-END');
  });

  it('omits only an unrun optional producer and retains the mandatory producer', () => {
    const f = runtime([declaration('remediation', ['fix-plan.md'], true), declaration('adjudicate', ['resolution.md'])],
      ['adjudicate']);
    expect(f.resolve()?.reports.map(({ reference, content }) => ({ reference, content })))
      .toEqual([{ reference: 'resolution.md', content: 'BODY-adjudicate' }]);
  });

  it('does not let an optional producer suppress an unrun mandatory producer', () => {
    const f = runtime([declaration('remediation', ['fix-plan.md'], true), declaration('adjudicate', ['resolution.md'])], []);
    expect(f.resolve).toThrow();
  });

  it('does not treat an executed optional producer with a missing report as unrun', () => {
    const f = runtime([declaration('remediation', ['fix-plan.md'], true), declaration('adjudicate', ['resolution.md'])],
      ['remediation', 'adjudicate']);
    rmSync(join(root, 'fix-plan.md'));
    expect(f.resolve).toThrow();
  });

  it('accepts non-overlapping producer declarations through workflow doctor', async () => {
    const file = saveWorkflow(rawWorkflow([declaration('remediation', ['fix-plan.md']), declaration('adjudicate', ['resolution.md'])]));
    await expect(doctorWorkflowCommand([file], root)).resolves.toBeUndefined();
  });

  it.each(['named', 'all', 'optional unrun'] as const)('rejects overlapping %s declarations in doctor and at runtime without a placeholder', async (mode) => {
    const inputs = [declaration('remediation', mode === 'all' ? 'all' : ['fix-plan.md'], mode === 'optional unrun'),
      declaration('adjudicate', mode === 'all' ? 'all' : ['fix-plan.md'])];
    const raw = rawWorkflow(inputs);
    raw.steps[1]!.output_contracts = { report: [{ name: 'fix-plan.md', format: '# Other plan\nWrite the plan.' }] };
    raw.steps[2]!.instruction = 'Consume the declared inputs';
    const file = saveWorkflow(raw);
    await expect(doctorWorkflowCommand([file], root)).rejects.toThrow();
    const config = loadWorkflowFromFile(file, root);
    const state = createInitialState(config, { projectCwd: root });
    const participation = new WorkflowStepParticipationIndex(new Map());
    for (const name of mode === 'optional unrun' ? ['adjudicate'] : ['remediation', 'adjudicate']) {
      participation.record(config, name, [], ['fix-plan.md']);
      state.stepOutputs.set(name, { persona: name, status: 'done', content: 'done', timestamp: new Date(0) });
    }
    writeFileSync(join(root, 'fix-plan.md'), 'SAME-NAME-BODY');
    expect(() => resolveDeclaredReportInputs(config.steps[2]!, {
      workflow: config, state, projectCwd: root, lookupCwd: root, reportDir: root, resumeStackPrefix: [],
      sharedRuntime: {
        startedAtMs: 0,
        workflowCallInvocationEvidence: { kind: 'exact', index: new WorkflowCallInvocationIndex(new Map()) },
        workflowStepParticipationIndex: participation,
      },
    })).toThrow();
  });

  it('rejects same public names from different parallel directories in doctor and complete prompt generation', async () => {
    const raw = {
      ...rawWorkflow([]),
      steps: [
        { name: 'remediation', parallel: [
          { name: 'left', output_contracts: { report: [{ name: 'left/review.md', format: '# Review\nWrite the review.' }] } },
          { name: 'right', output_contracts: { report: [{ name: 'right/review.md', format: '# Review\nWrite the review.' }] } },
        ], rules: [{ condition: 'all("done")', next: 'consumer' }] },
        { name: 'consumer', instruction: 'Consume the declared inputs', input_reports: declaration('remediation', 'all'),
          rules: [{ condition: 'done', next: 'COMPLETE' }] },
      ],
    };
    const file = saveWorkflow(raw);
    await expect(doctorWorkflowCommand([file], root)).rejects.toThrow();
    const config = loadWorkflowFromFile(file, root);
    const prepare = () => new InstructionBuilder(config.steps[1]!, makeInstructionContext({
      reportDir: root,
      declaredReportInputs: [resolveDeclaredReportInputs(config.steps[1]!, {
        workflow: config, state: createInitialState(config, { projectCwd: root }),
        projectCwd: root, lookupCwd: root, reportDir: root, resumeStackPrefix: [],
        sharedRuntime: {
          startedAtMs: 0,
          workflowCallInvocationEvidence: { kind: 'exact', index: new WorkflowCallInvocationIndex(new Map()) },
          workflowStepParticipationIndex: new WorkflowStepParticipationIndex(new Map()),
        },
      })!],
    })).prepare();
    expect(prepare).toThrow();
  });

  it.each(['step', 'parallel', 'nested workflow'] as const)('rejects duplicate contract paths for an explicitly selected report from a %s in doctor', async (kind) => {
    const contracts = ['left/review.md', 'right/review.md'].map((name) => ({ name, format: '# Review\nWrite the review.' }));
    if (kind === 'nested workflow') {
      writeFileSync(join(root, 'nested.yaml'), JSON.stringify({
        name: 'nested', subworkflow: { callable: true }, steps: [
          { name: 'left', output_contracts: { report: [contracts[0]!] }, rules: [{ condition: 'done', next: 'right' }] },
          { name: 'right', output_contracts: { report: [contracts[1]!] }, rules: [{ condition: 'done', next: 'COMPLETE' }] },
        ],
      }));
    }
    const sources = {
      step: { name: 'remediation', output_contracts: { report: contracts }, rules: [{ condition: 'done', next: 'consumer' }] },
      parallel: { name: 'remediation', parallel: [
        { name: 'left', output_contracts: { report: [contracts[0]!] } },
        { name: 'right', output_contracts: { report: [contracts[1]!] } },
      ], rules: [{ condition: 'all("done")', next: 'consumer' }] },
      'nested workflow': { name: 'remediation', kind: 'workflow_call', call: './nested.yaml', rules: [{ condition: 'COMPLETE', next: 'consumer' }] },
    };
    const raw = {
      ...rawWorkflow([]),
      steps: [sources[kind], { name: 'consumer', instruction: 'Consume the declared inputs',
        input_reports: declaration('remediation', ['review.md']), rules: [{ condition: 'done', next: 'COMPLETE' }] }],
    };
    await expect(doctorWorkflowCommand([saveWorkflow(raw)], root)).rejects.toThrow();
  });

  it('preserves array inputs and history when loading a judge declaration', () => {
    const input = [{ ...declaration('remediation', ['fix-plan.md']), history: { previous: 2 } }];
    const judge = { instruction: '{report:fix-plan.md}\n{report_history:fix-plan.md}', input_reports: input,
      rules: [{ condition: 'done', next: 'COMPLETE' }] };
    expect(LoopMonitorJudgeSchema.parse(judge)).toMatchObject({ input_reports: input });
    const raw = { ...rawWorkflow(declaration('remediation', ['fix-plan.md'])),
      loop_monitors: [{ cycle: ['remediation', 'adjudicate'], threshold: 2, judge }] };
    expect(loadWorkflowFromFile(saveWorkflow(raw), root).loopMonitors?.[0]?.judge).toMatchObject({
      inputReports: [{ fromStep: 'remediation', reports: ['fix-plan.md'], history: { previous: 2 } }],
    });
  });

  it.each([
    { kind: 'an undeclared name', reference: 'unknown.md' },
    { kind: 'a declaration without history', reference: 'fix-plan.md' },
  ])('rejects a step history reference to $kind through workflow doctor', async ({ reference }) => {
    const raw = rawWorkflow(declaration('remediation', ['fix-plan.md']));
    raw.steps[2]!.instruction = `Inspect the prior result\n{report_history:${reference}}`;
    await expect(doctorWorkflowCommand([saveWorkflow(raw)], root)).rejects.toThrow('Workflow validation failed');
  });

  it('rejects an invalid loop monitor judge history reference through workflow doctor', async () => {
    const input = declaration('remediation', ['fix-plan.md']);
    const raw = { ...rawWorkflow(input), loop_monitors: [{
      cycle: ['remediation', 'adjudicate'], threshold: 2,
      judge: { instruction: 'Inspect the prior result\n{report_history:fix-plan.md}', input_reports: input,
        rules: [{ condition: 'done', next: 'COMPLETE' }] },
    }] };
    await expect(doctorWorkflowCommand([saveWorkflow(raw)], root)).rejects.toThrow('Workflow validation failed');
  });

  it.each(['step', 'loop monitor judge'] as const)('accepts a declared history reference on a %s through workflow doctor', async (consumer) => {
    const input = { ...declaration('remediation', ['fix-plan.md']), history: { previous: 2 } };
    const instruction = '{report:fix-plan.md}\n{report_history:fix-plan.md}';
    const raw = {
      ...rawWorkflow(input),
      ...(consumer === 'loop monitor judge' ? { loop_monitors: [{
        cycle: ['remediation', 'adjudicate'], threshold: 2,
        judge: { instruction, input_reports: input, rules: [{ condition: 'done', next: 'COMPLETE' }] },
      }] } : {}),
    };
    raw.steps[2]!.instruction = instruction;
    await expect(doctorWorkflowCommand([saveWorkflow(raw)], root)).resolves.toBeUndefined();
  });

  it.each([false, true])('resolves nested producer report names in doctor (overlap=%s)', async (overlap) => {
    for (const [name, file] of [['first', 'fix-plan.md'], ['second', overlap ? 'fix-plan.md' : 'resolution.md']]) {
      writeFileSync(join(root, `${name}.yaml`), JSON.stringify({
        name, subworkflow: { callable: true }, steps: [{
          name: 'write', output_contracts: { report: [{ name: file, format: '# Report\nWrite the evidence.' }] },
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        }],
      }));
    }
    const raw = {
      ...rawWorkflow([]),
      steps: [
        { name: 'remediation', kind: 'workflow_call', call: './first.yaml', rules: [{ condition: 'COMPLETE', next: 'adjudicate' }] },
        { name: 'adjudicate', kind: 'workflow_call', call: './second.yaml', rules: [{ condition: 'COMPLETE', next: 'consumer' }] },
        { name: 'consumer', instruction: 'Consume the supplied reports',
          input_reports: [declaration('remediation', 'all'), declaration('adjudicate', 'all')],
          rules: [{ condition: 'done', next: 'COMPLETE' }] },
      ],
    };
    const result = doctorWorkflowCommand([saveWorkflow(raw)], root);
    if (overlap) await expect(result).rejects.toThrow();
    else await expect(result).resolves.toBeUndefined();
  });

  it('rejects a judge source outside its cycle through workflow doctor', async () => {
    const raw = { ...rawWorkflow(declaration('remediation', ['fix-plan.md'])), loop_monitors: [{
      cycle: ['adjudicate', 'consumer'], threshold: 2,
      judge: { instruction: 'Inspect progress', input_reports: declaration('remediation', ['fix-plan.md']),
        rules: [{ condition: 'done', next: 'COMPLETE' }] },
    }] };
    await expect(doctorWorkflowCommand([saveWorkflow(raw)], root)).rejects.toThrow();
  });
});

describe('report execution versions', () => {
  let root: string;
  let store: ReportExecutionStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-report-executions-'));
    store = new ReportExecutionStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keeps incomplete executions out of selection and explains their state', () => {
    const unfinished = store.begin('source', 'remediation', root, ['plan.md']);
    store.capture(root, 'plan.md', 'unfinished');
    expect(() => store.current('source', 'plan.md')).toThrow();
    const complete = store.begin('source', 'remediation', root, ['plan.md']);
    store.capture(root, 'plan.md', 'current');
    store.finish(complete, true);
    expect(store.current('source', 'plan.md')?.content).toBe('current');
    const history = store.history('source', 'plan.md', 2);
    expect(history).toContain('0 / 2');
    expect(history).toContain(unfinished);
    expect(history).toContain('status=incomplete');
    expect(history).not.toContain('path=');
  });

  it('keeps a missing report in the selected execution instead of using an older body', () => {
    const first = store.begin('source', 'remediation', root, ['plan.md', 'report.md']);
    store.capture(root, 'plan.md', 'old plan');
    store.capture(root, 'report.md', 'old report');
    store.finish(first, true);
    const missing = store.begin('source', 'remediation', root, ['plan.md', 'report.md']);
    store.capture(root, 'plan.md', 'next plan');
    store.finish(missing, true);
    expect(() => store.current('source', 'report.md')).toThrow();
    const current = store.begin('source', 'remediation', root, ['plan.md', 'report.md']);
    store.capture(root, 'plan.md', 'current plan');
    store.capture(root, 'report.md', 'current report');
    store.finish(current, true);
    const history = store.history('source', 'report.md', 1);
    expect(history).toContain(missing);
    expect(history).toContain('report=missing');
    expect(history).not.toContain(first);
    expect(history).not.toContain('path=');
  });

  it('pins accepted bodies before completion and restores identities without changing files', () => {
    const id = store.begin('source', 'remediation', root, ['plan.md']);
    store.capture(root, 'plan.md', 'accepted body');
    const record = store.executions('source')[0]!;
    const path = join(root, record.reports['plan.md']!);
    expect(readFileSync(path, 'utf8')).toBe('accepted body');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    store.finish(id, true);
    const restored = new ReportExecutionStore(root);
    expect(restored.current('source', 'plan.md')).toMatchObject({ content: 'accepted body', path });
    expect(restored.executions('source')[0]?.id).toBe(id);
    expect(restored.history('source', 'plan.md', 0)).not.toContain('path=');
  });

  it('isolates interleaved producer namespaces and groups nested reports under their call', () => {
    const parent = store.begin('parent', 'remediation', root, []);
    const left = store.begin('left', 'writer', join(root, 'left'), ['plan.md']);
    const right = store.begin('right', 'writer', join(root, 'right'), ['report.md']);
    store.capture(join(root, 'left'), 'plan.md', 'left plan');
    store.capture(join(root, 'right'), 'report.md', 'right report');
    store.finish(left, true);
    store.finish(right, true);
    store.finish(parent, true);
    expect(store.current('left', 'plan.md')?.content).toBe('left plan');
    expect(() => store.current('left', 'report.md')).toThrow();
    expect(store.current('parent', 'left/plan.md')?.content).toBe('left plan');
    expect(store.current('parent', 'right/report.md')?.content).toBe('right report');
    expect(store.executions('parent')[0]?.id).toBe(parent);
  });

  it('continues an interrupted execution only when explicitly resumed', () => {
    const interrupted = store.begin('source', 'remediation', root, ['plan.md']);
    store.capture(root, 'plan.md', 'partial');
    store.finish(interrupted, false);
    const resumed = new ReportExecutionStore(root);
    const resumedId = resumed.begin('source', 'remediation', root, ['plan.md'], true);
    expect(resumedId).toBe(interrupted);
    resumed.capture(root, 'plan.md', 'finished');
    resumed.finish(resumedId, true);
    expect(resumed.executions('source')).toHaveLength(1);
    expect(resumed.current('source', 'plan.md')?.content).toBe('finished');
    const next = resumed.begin('source', 'remediation', root, ['plan.md']);
    expect(next).not.toBe(interrupted);
  });

  it('orders distinct child producers globally while retaining their shared call identity', () => {
    const parent = store.begin('parent', 'remediation', root, []);
    const childDir = join(root, 'child');
    const fix = store.begin('fix', 'fix', childDir, ['fix-report.md']);
    store.capture(childDir, 'fix-report.md', 'fixed');
    store.finish(fix, true);
    const verify = store.begin('verify', 'fix-verifier', childDir, ['verification.md']);
    store.capture(childDir, 'verification.md', 'verified');
    store.finish(verify, true);
    store.finish(parent, true);
    const repaired = store.current('parent', 'child/fix-report.md')!;
    const verified = store.current('parent', 'child/verification.md')!;
    expect(repaired.execution).toEqual(verified.execution);
    expect(repaired.execution.id).toContain(parent);
    expect(repaired.origin).toMatchObject({ producer: 'fix', order: 2, completionOrder: 3 });
    expect(verified.origin).toMatchObject({ producer: 'fix-verifier', order: 4, completionOrder: 5 });
    expect(verified.origin.order).toBeGreaterThan(repaired.origin.completionOrder!);
    expect(repaired.execution.completionOrder).toBe(6);
  });

  it('keeps same-directory parallel child captures within their declared reports', () => {
    const parent = store.begin('parent', 'remediation', root, ['plan.md', 'report.md']);
    const alphaIdentity = buildWorkflowStepParticipationIdentity('parallel-origin', 'alpha', [], 'remediation');
    const betaIdentity = buildWorkflowStepParticipationIdentity('parallel-origin', 'beta', [], 'remediation');
    const alpha = store.begin(alphaIdentity, 'alpha', root, ['plan.md']);
    const beta = store.begin(betaIdentity, 'beta', root, ['report.md']);
    store.capture(root, 'plan.md', 'alpha plan');
    store.capture(root, 'report.md', 'beta report');
    store.finish(beta, true);
    store.finish(alpha, true);
    store.finish(parent, true);

    expect(store.current('parent', 'plan.md')?.origin).toMatchObject({ producer: 'alpha' });
    expect(store.current('parent', 'report.md')?.origin).toMatchObject({ producer: 'beta' });
    expect(store.executions(alphaIdentity)[0]?.reports['report.md']).toBeUndefined();
    expect(store.executions(betaIdentity)[0]?.reports['plan.md']).toBeUndefined();
  });

  it('shows incomplete executions and missing reports in the completed instruction without backfilling', () => {
    const unfinished = store.begin('source', 'remediation', root, ['report.md']);
    store.capture(root, 'report.md', 'PARTIAL-REPORT');
    store.finish(unfinished, false);
    const missing = store.begin('source', 'remediation', root, ['report.md']);
    store.finish(missing, true);
    const current = store.begin('source', 'remediation', root, ['report.md']);
    store.capture(root, 'report.md', 'CURRENT-REPORT');
    store.finish(current, true);
    const fixed = store.current('source', 'report.md')!;
    const step = makeStep({ instruction: '{report:report.md}\n{report_history:report.md}',
      inputReports: { fromStep: 'remediation', reports: ['report.md'], history: { previous: 2 } } });
    const prepared = new InstructionBuilder(step, makeInstructionContext({ reportDir: root, declaredReportInputs: [{
      declaredNames: ['report.md'], reports: [{ reference: 'report.md', scope: 'declared-producer', producer: 'remediation',
        ...fixed, history: store.history('source', 'report.md', 2) }],
    }] })).prepare();
    expect(prepared.text).toContain('CURRENT-REPORT');
    expect(prepared.text).toContain('History: 1 / 2');
    expect(prepared.text).toMatch(new RegExp(`${missing}[^\\n]*status=completed[^\\n]*report=missing`));
    expect(prepared.text).toMatch(new RegExp(`${unfinished}[^\\n]*status=incomplete`));
    expect(prepared.text).not.toContain('PARTIAL-REPORT');
    expect(prepared.injectedReports.find((report) => report.kind === 'history')?.path).toBeUndefined();
  });

  it('keeps same-name nested reports distinct across repeated call occurrences', () => {
    const paths: string[] = [];
    for (const occurrence of [1, 2]) {
      const id = store.begin('source', 'remediation', root, []);
      for (const producer of ['alpha', 'beta']) {
        const namespace = join('subworkflows', buildWorkflowCallNamespaceSegment(producer, 'child', occurrence));
        store.capture(join(root, namespace), 'review.md', `${producer}-${occurrence}`);
        if (occurrence === 2) paths.push(join(namespace, 'review.md'));
      }
      store.finish(id, true);
    }
    for (const [index, producer] of ['alpha', 'beta'].entries()) {
      expect(store.current('source', paths[index]!)?.content).toBe(`${producer}-2`);
      const history = store.history('source', paths[index]!, 1);
      const pinned = history.match(/path=`([^`]+)`/)?.[1];
      expect(pinned).toBeDefined();
      expect(readFileSync(pinned!, 'utf8')).toBe(`${producer}-1`);
    }
  });
});
