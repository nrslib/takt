import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import { runWorkflowExecution } from '../features/tasks/execute/workflowExecutionApi.js';
import * as bundles from '../features/tasks/execute/workflowExecutionBundle.js';
import { doctorWorkflowCommand } from '../features/workflowAuthoring/doctor.js';

const { warnings } = vi.hoisted(() => ({ warnings: vi.fn() }));
vi.mock('../features/tasks/execute/outputFns.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/tasks/execute/outputFns.js')>();
  return {
    ...actual,
    createOutputFns: (...args: Parameters<typeof actual.createOutputFns>) => {
      const output = actual.createOutputFns(...args);
      return { ...output, warn: (message: string) => { warnings(message); output.warn(message); } };
    },
  };
});

describe('execution report reference validation with a real bundle', () => {
  let root: string;
  let promptLog: string;
  const route = (next: string) => [{ condition: 'when(true)', next }];
  const call = (name: string, next: string, args?: Record<string, string>) => ({
    name, kind: 'workflow_call', call: 'child', ...(args === undefined ? {} : { args }),
    rules: [{ condition: 'COMPLETE', next }],
  });
  const produce = (next: string) => ({
    name: 'produce', persona: 'planner', instruction: 'Prepare the plan',
    output_contracts: { report: [{ name: 'plan.md', format: 'plan-format' }] }, rules: route(next),
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-report-validation-'));
    promptLog = join(root, 'prompts.jsonl');
    const globalDir = join(root, 'global');
    mkdirSync(globalDir);
    writeFileSync(join(globalDir, 'config.yaml'), 'provider: mock\nnotification_sound: false\nprevent_sleep: false\n');
    vi.stubEnv('TAKT_CONFIG_DIR', globalDir);
    vi.stubEnv('TAKT_MOCK_PROMPT_LOG', promptLog);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    warnings.mockClear();
    resetScenario();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    resetScenario();
    resetAnalyticsWriter();
    rmSync(root, { recursive: true, force: true });
  });

  function writeWorkflow(name: string, steps: unknown[], extra: Record<string, unknown> = {}): void {
    const directory = join(root, '.takt', 'workflows');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.yaml`), stringify({
      name, initial_step: (steps[0] as { name: string }).name, max_steps: 10,
      report_formats: { 'plan-format': 'Plan body' }, ...extra, steps,
    }));
  }

  function writeChild(instruction: unknown = 'Consume {report:plan.md}', extra: Record<string, unknown> = {}): void {
    writeWorkflow('child', [{ name: 'work', persona: 'worker', instruction, rules: route('COMPLETE') }], {
      subworkflow: { callable: true, ...extra },
    });
  }

  const run = (workflowIdentifier = 'parent') => runWorkflowExecution({
    cwd: root, projectCwd: root, workflowIdentifier, task: 'Validate report references',
    agentOverrides: { provider: 'mock' }, outputMode: 'silent',
    reportDirName: '20261005-120000-references',
  });

  function recordedPrompts(): { personaName: string; prompt: string }[] {
    return readFileSync(promptLog, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { personaName: string; prompt: string });
  }

  function workPrompts(): string[] {
    return recordedPrompts()
      .filter(({ personaName }) => personaName === 'worker')
      .map(({ prompt }) => prompt);
  }

  it.each(['parent', 'child'])('warns when an unselected parent pool is inspected from %s', async (target) => {
    writeChild();
    const participant = (name: string) => ({
      name, persona: name, instruction: `Run ${name}`,
      rules: [{ condition: 'done' }],
    });
    writeWorkflow('parent', [{
      name: 'select',
      parallel: {
        fixed: [participant('idle')],
        pool: [{ ...produce('delegate'), description: 'Prepare the plan', rules: [{ condition: 'done' }] }, { ...participant('other'), description: 'Run other' }],
        selection: { mode: 'replace' },
      },
      rules: [{ condition: 'all("done")', next: 'delegate' }],
    }, call('delegate', 'COMPLETE')]);
    const personaDir = join(root, '.takt', 'facets', 'personas');
    mkdirSync(personaDir, { recursive: true });
    for (const persona of ['planner', 'worker', 'idle', 'other']) {
      writeFileSync(join(personaDir, `${persona}.md`), `You are ${persona}`);
    }
    const doctorWarnings = vi.spyOn(console, 'log');
    await doctorWorkflowCommand([target], root);
    const doctorMessages = doctorWarnings.mock.calls.map(([message]) => String(message))
      .filter((message) => message.includes(' references {report:'));
    setMockScenario([
      { persona: 'dynamic-parallel-selector', status: 'done', content: 'Select other', structuredOutput: { selected_ids: ['other'], rationale: 'Run other' } },
      { persona: 'idle', status: 'done', content: '[STEP:1]' },
      { persona: 'other', status: 'done', content: '[STEP:1]' },
      { persona: 'worker', status: 'done', content: 'Consumed' },
    ]);

    expect((await run()).success).toBe(true);
    const reportPath = join(root, '.takt', 'runs', '20261005-120000-references', 'reports', 'plan.md');
    const prompts = recordedPrompts();
    expect(existsSync(reportPath)).toBe(false);
    expect(prompts.map(({ personaName }) => personaName)).toEqual(['dynamic-parallel-selector', 'idle', 'other', 'worker']);
    expect(workPrompts()).toHaveLength(1);
    expect(doctorMessages).toEqual([expect.stringContaining('{report:plan.md}')]);
    expect(doctorMessages[0]).toContain('work');
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('{report:plan.md}'));
  });

  it.each([
    { fixed: [], pool: ['produce'], selectedIds: ['produce'], produces: true },
    { fixed: ['produce'], pool: ['idle'], selectedIds: [], produces: true },
    { fixed: ['idle'], pool: ['produce'], selectedIds: [], produces: false },
    { fixed: [], pool: ['produce', 'other'], selectedIds: ['other'], produces: false },
    { fixed: [], pool: ['produce', 'other'], selectedIds: ['produce'], produces: true },
    { fixed: ['idle'], pool: ['produce', 'other'], selectedIds: ['produce'], produces: true },
    { fixed: ['idle'], pool: ['produce', 'other'], selectedIds: ['other'], produces: false },
    { fixed: ['idle'], pool: ['produce', 'other'], selectedIds: [], produces: false },
  ].flatMap((fixture) => ['replace', 'cumulative'].map((mode) => ({ ...fixture, mode }))))('matches runtime reports with fixed=$fixed pool=$pool selection=$selectedIds mode=$mode', async ({ fixed, pool, selectedIds, produces, mode }) => {
    writeChild();
    const participant = (name: string) => name === 'produce'
      ? { ...produce('delegate'), rules: [{ condition: 'done' }] }
      : { name, persona: name, instruction: `Run ${name}`, rules: [{ condition: 'done' }] };
    writeWorkflow('parent', [{
      name: 'select',
      parallel: {
        fixed: fixed.map(participant),
        pool: pool.map((name) => ({ ...participant(name), description: `Run ${name}` })),
        selection: { mode },
      },
      rules: [{ condition: 'all("done")', next: 'delegate' }],
    }, call('delegate', 'COMPLETE')]);
    const selected = new Set(selectedIds);
    const executed = [...fixed, ...pool.filter((name) => selected.has(name))];
    setMockScenario([
      { persona: 'dynamic-parallel-selector', status: 'done', content: 'Select participants', structuredOutput: { selected_ids: selectedIds, rationale: 'Run selected participants' } },
      ...executed.flatMap((name) => name === 'produce' ? [
        { persona: 'planner', status: 'done' as const, content: '[STEP:1]' },
        { persona: 'planner', status: 'done' as const, content: 'PARENT_PLAN_BODY' },
      ] : [{ persona: name, status: 'done' as const, content: '[STEP:1]' }]),
      { persona: 'worker', status: 'done', content: 'Consumed' },
    ]);

    expect((await run()).success).toBe(true);

    const reportPath = join(root, '.takt', 'runs', '20261005-120000-references', 'reports', 'plan.md');
    const prompts = recordedPrompts();
    expect(new Set(prompts.map(({ personaName }) => personaName))).toEqual(new Set([
      'dynamic-parallel-selector', ...executed.map((name) => name === 'produce' ? 'planner' : name), 'worker',
    ]));
    expect(workPrompts()).toHaveLength(1);
    expect(existsSync(reportPath)).toBe(produces);
    if (produces) {
      expect(readFileSync(reportPath, 'utf8')).toBe('PARENT_PLAN_BODY');
      expect(workPrompts()[0]).toContain('PARENT_PLAN_BODY');
      expect(warnings).not.toHaveBeenCalled();
    } else {
      expect(warnings).toHaveBeenCalledWith(expect.stringContaining('{report:plan.md}'));
      expect(workPrompts()[0]).not.toContain('PARENT_PLAN_BODY');
    }
  });

  it.each([true, false])('uses only reports produced before the call (producer first: %s)', async (producerFirst) => {
    writeChild();
    writeWorkflow('parent', producerFirst
      ? [produce('delegate'), call('delegate', 'COMPLETE')]
      : [call('delegate', 'produce'), produce('COMPLETE')]);
    setMockScenario([
      { persona: 'planner', status: 'done', content: 'Plan prepared' },
      { persona: 'planner', status: 'done', content: 'PARENT_PLAN_BODY' },
      { persona: 'worker', status: 'done', content: 'Consumed' },
    ]);

    expect((await run()).success).toBe(true);
    expect(workPrompts()).toHaveLength(1);
    if (producerFirst) {
      expect(warnings).not.toHaveBeenCalled();
      expect(workPrompts()[0]).toContain('PARENT_PLAN_BODY');
    } else {
      expect(warnings).toHaveBeenCalledWith(expect.stringContaining('{report:plan.md}'));
      expect(workPrompts()[0]).not.toContain('PARENT_PLAN_BODY');
    }
  });

  it.each(['instruction', 'parallel instruction', 'parallel call', 'grandchild', 'judge']
    .flatMap((consumer) => ['produce', 'other'].map((selectedId) => ({ consumer, selectedId }))))(
    'uses resolved reports for $consumer when selecting $selectedId',
    async ({ consumer, selectedId }) => {
      const work = {
        name: 'work', persona: 'worker', instruction: 'Consume {report: plan.md }',
        rules: route('COMPLETE'),
      };
      writeChild(work.instruction);
      const select = {
        name: 'select',
        parallel: {
          fixed: [],
          pool: [
            { ...produce('consume'), description: 'Prepare the plan', rules: [{ condition: 'done' }] },
            { name: 'other', persona: 'other', description: 'Run other', instruction: 'Run other', rules: [{ condition: 'done' }] },
          ],
          selection: { mode: 'replace' },
        },
        rules: [{ condition: 'all("done")', next: 'consume' }],
      };
      let consume: unknown = { ...work, name: 'consume' };
      const extra: Record<string, unknown> = {};
      if (consumer === 'parallel instruction') {
        consume = { name: 'consume', parallel: [{ ...work, rules: [{ condition: 'done' }] }],
          rules: [{ condition: 'all("done")', next: 'COMPLETE' }] };
      } else if (consumer === 'parallel call') {
        consume = { name: 'consume', parallel: [
          { ...call('left', 'COMPLETE'), rules: [{ condition: 'COMPLETE' }] },
          { ...call('right', 'COMPLETE'), rules: [{ condition: 'COMPLETE' }] },
        ], rules: [{ condition: 'all("COMPLETE")', next: 'COMPLETE' }] };
      } else if (consumer === 'grandchild') {
        writeWorkflow('grandchild', [work], { subworkflow: { callable: true } });
        writeWorkflow('child', [{ ...call('delegate', 'COMPLETE'), call: 'grandchild' }], {
          subworkflow: { callable: true },
        });
        consume = call('consume', 'COMPLETE');
      } else if (consumer === 'judge') {
        consume = { name: 'consume', persona: 'idle', instruction: 'Complete cycle', rules: route('select') };
        extra.loop_monitors = [{
          cycle: ['select', 'consume'], threshold: 1,
          judge: { persona: 'worker', instruction: work.instruction, rules: route('COMPLETE') },
        }];
      }
      writeWorkflow('parent', [select, consume], extra);
      const produces = selectedId === 'produce';
      setMockScenario([
        { persona: 'dynamic-parallel-selector', status: 'done', content: 'Select participants', structuredOutput: { selected_ids: [selectedId], rationale: 'Run selected participant' } },
        ...(produces ? [
          { persona: 'planner', status: 'done' as const, content: '[STEP:1]' },
          { persona: 'planner', status: 'done' as const, content: 'PARENT_PLAN_BODY' },
        ] : [{ persona: 'other', status: 'done' as const, content: '[STEP:1]' }]),
        ...(consumer === 'judge' ? [{ persona: 'idle', status: 'done' as const, content: 'Cycle done' }] : []),
        { persona: 'worker', status: 'done', content: '[STEP:1]' },
        ...(consumer === 'parallel call' ? [{ persona: 'worker', status: 'done' as const, content: '[STEP:1]' }] : []),
      ]);

      expect((await run()).success).toBe(true);
      const prompts = workPrompts();
      expect(prompts).toHaveLength(consumer === 'parallel call' ? 2 : 1);
      expect(existsSync(join(root, '.takt', 'runs', '20261005-120000-references', 'reports', 'plan.md'))).toBe(produces);
      for (const prompt of prompts) {
        if (produces) expect(prompt).toContain('PARENT_PLAN_BODY');
        else expect(prompt).not.toContain('PARENT_PLAN_BODY');
      }
      expect(warnings).toHaveBeenCalledTimes(produces ? 0 : prompts.length);
      if (!produces) {
        for (const [message] of warnings.mock.calls) {
          expect(message).toContain('{report:plan.md}');
        }
        if (consumer === 'parallel call') {
          expect(warnings).toHaveBeenCalledWith(expect.stringContaining('parent:left'));
          expect(warnings).toHaveBeenCalledWith(expect.stringContaining('parent:right'));
        }
      }
    },
  );

  it.each([true, false])('only diagnoses consumed references, rather than output formats (instruction reference: %s)', async (instructionReference) => {
    writeWorkflow('child', [{
      name: 'work', persona: 'worker',
      instruction: instructionReference ? 'Consume {report:plan.md}' : 'Consume',
      output_contracts: { report: [{ name: 'result.md', format: 'result-format' }] },
      rules: route('COMPLETE'),
    }], { subworkflow: { callable: true }, report_formats: { 'result-format': 'Keep {report:plan.md}' } });
    writeWorkflow('parent', [{
      name: 'select',
      parallel: {
        fixed: [{ name: 'idle', persona: 'idle', instruction: 'Run idle', rules: [{ condition: 'done' }] }],
        pool: [
          { ...produce('delegate'), description: 'Prepare the plan', rules: [{ condition: 'done' }] },
          { name: 'other', persona: 'other', description: 'Run other', instruction: 'Run other', rules: [{ condition: 'done' }] },
        ],
        selection: { mode: 'replace' },
      },
      rules: [{ condition: 'all("done")', next: 'delegate' }],
    }, call('delegate', 'COMPLETE')]);
    setMockScenario([
      { persona: 'dynamic-parallel-selector', status: 'done', content: 'Select participants', structuredOutput: { selected_ids: ['other'], rationale: 'Run other' } },
      { persona: 'idle', status: 'done', content: '[STEP:1]' },
      { persona: 'other', status: 'done', content: '[STEP:1]' },
      { persona: 'worker', status: 'done', content: 'Consumed' },
      { persona: 'worker', status: 'done', content: 'RESULT_BODY' },
    ]);

    expect((await run()).success).toBe(true);
    expect(warnings).toHaveBeenCalledTimes(instructionReference ? 1 : 0);
    expect(workPrompts()).toHaveLength(2);
    expect(workPrompts()[0]).toContain('Keep {report:plan.md}');
  });

  it('does not use an external caller when running the callable child alone', async () => {
    writeChild();
    writeWorkflow('parent', [produce('delegate'), call('delegate', 'COMPLETE')]);
    setMockScenario([{ persona: 'worker', status: 'done', content: 'Consumed' }]);

    expect((await run('child')).success).toBe(true);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('{report:plan.md}'));
  });

  it.each(['normal', 'run context'] as const)('rejects an invalid child reference before %s execution starts', async (entry) => {
    writeChild('Consume {report:../plan.md}');
    writeWorkflow('parent', [produce('delegate'), call('delegate', 'COMPLETE')]);
    const eventSink = vi.fn();
    const consoleOutput = vi.spyOn(console, 'log');

    await expect(runWorkflowExecution({
      cwd: root, projectCwd: root, workflowIdentifier: 'parent', task: 'Validate report references',
      agentOverrides: { provider: 'mock' }, outputMode: 'silent', eventSink,
      reportDirName: '20261005-120000-references',
    }, entry === 'normal' ? undefined : {})).rejects.toThrow();

    expect(existsSync(promptLog)).toBe(false);
    expect(eventSink).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'run_started' }));
    expect(consoleOutput).not.toHaveBeenCalled();
    const meta = JSON.parse(readFileSync(join(root, '.takt', 'runs', '20261005-120000-references', 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      status: 'failed', iterations: 0,
    });
  });

  it('keeps args-specific child definitions distinct after source workflows are removed', async () => {
    const instructionDir = join(root, '.takt', 'facets', 'instructions');
    mkdirSync(instructionDir, { recursive: true });
    writeFileSync(join(instructionDir, 'present.md'), 'Consume {report:plan.md}');
    writeFileSync(join(instructionDir, 'absent.md'), 'Consume {report:other.md}');
    writeChild({ $param: 'work_instruction' }, {
      params: { work_instruction: { type: 'facet_ref', facet_kind: 'instruction' } },
    });
    writeWorkflow('parent', [produce('first'),
      call('first', 'second', { work_instruction: 'present' }),
      call('second', 'COMPLETE', { work_instruction: 'absent' }),
    ]);
    setMockScenario([
      { persona: 'planner', status: 'done', content: 'Plan prepared' },
      { persona: 'planner', status: 'done', content: 'PARENT_PLAN_BODY' },
      { persona: 'worker', status: 'done', content: 'First consumed' },
      { persona: 'worker', status: 'done', content: 'Second consumed' },
    ]);
    const publish = bundles.publishWorkflowExecutionBundle;
    vi.spyOn(bundles, 'publishWorkflowExecutionBundle').mockImplementationOnce((...args) => {
      publish(...args);
      rmSync(join(root, '.takt', 'workflows'), { recursive: true });
      rmSync(instructionDir, { recursive: true });
    });

    expect((await run()).success).toBe(true);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('{report:other.md}'));
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('parent:second'));
    expect(workPrompts()).toHaveLength(2);
    expect(workPrompts()[0]).toContain('PARENT_PLAN_BODY');
    expect(workPrompts()[1]).not.toContain('PARENT_PLAN_BODY');
  });

  it('distinguishes workflows with the same name and args using bundle node IDs', async () => {
    const childStep = (reference: string) => ({
      name: 'work', persona: 'worker', instruction: `Consume {report:${reference}}`, rules: route('COMPLETE'),
    });
    writeWorkflow('child', [childStep('plan.md')], { name: 'shared', subworkflow: { callable: true } });
    writeWorkflow('other', [childStep('other.md')], { name: 'shared', subworkflow: { callable: true } });
    writeWorkflow('parent', [produce('first'), call('first', 'second'), {
      ...call('second', 'COMPLETE'), call: 'other',
    }], { name: 'shared' });
    setMockScenario([
      { persona: 'planner', status: 'done', content: 'Plan prepared' },
      { persona: 'planner', status: 'done', content: 'PARENT_PLAN_BODY' },
      { persona: 'worker', status: 'done', content: 'First consumed' },
      { persona: 'worker', status: 'done', content: 'Second consumed' },
    ]);

    expect((await run()).success).toBe(true);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('shared:second'));
    expect(workPrompts()[0]).toContain('PARENT_PLAN_BODY');
    expect(workPrompts()[1]).not.toContain('PARENT_PLAN_BODY');
  });
});
