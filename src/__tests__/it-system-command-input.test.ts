import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowConfig, WorkflowStep, WorkflowSystemInput } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';
import { makeRule, makeStep } from './test-helpers.js';

type CommandInput = Extract<WorkflowSystemInput, { type: 'command' }>;

describe('command system input execution', () => {
  let projectDir: string;
  let executionDir: string;
  let runsDir: string;
  const engines: WorkflowEngine[] = [];

  beforeEach(() => {
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'takt-command-input-')));
    executionDir = join(projectDir, 'clone');
    runsDir = join(projectDir, 'central-runs');
    mkdirSync(executionDir);
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    for (const engine of engines.splice(0)) {
      engine.abort();
      engine.removeAllListeners();
    }
    resetScenario();
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    const childPidPath = join(executionDir, 'child-pid');
    if (existsSync(childPidPath)) {
      const pid = Number(readFileSync(childPidPath, 'utf8'));
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  function script(name: string, source: string): string {
    writeFileSync(join(executionDir, `${name}.mjs`), source);
    return `node ${name}.mjs`;
  }

  function commandStep(command: string, overrides: Partial<CommandInput> = {}): WorkflowStep {
    const input: CommandInput = { type: 'command', as: 'approval', command, timeout_ms: 5000, ...overrides };
    return makeStep({
      name: 'check', kind: 'system',
      systemInputs: [input],
      rules: [makeRule('when(context.check.approval.exit_code == 0)', 'COMPLETE'), makeRule('when(true)', 'ABORT')],
    });
  }

  function engineFor(steps: WorkflowStep[], overrides: Partial<WorkflowConfig> = {}, options: Partial<WorkflowEngineOptions> = {}): WorkflowEngine {
    const config: WorkflowConfig = {
      name: 'command-input', initialStep: steps[0]!.name, maxSteps: 10, steps, ...overrides,
    };
    const engine = new WorkflowEngine(config, executionDir, 'Inspect approval', {
      projectCwd: projectDir, provider: 'mock', runPathsDirectory: runsDir,
      reportDirName: 'command-input',
      structuredCaller: {
        judgeStatus: vi.fn(), evaluateCondition: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      },
      systemStepServicesFactory: createDefaultSystemStepServices,
      ...options,
    });
    engines.push(engine);
    return engine;
  }

  it('routes a nonzero exit using exit_code, timed_out, stdout and stderr', async () => {
    const step = commandStep(script('nonzero', "process.stdout.write('pending'); process.stderr.write('retry'); process.exitCode = 3;"));
    step.rules = [
      makeRule('when(context.check.approval.exit_code == 3 && context.check.approval.timed_out == false && context.check.approval.stdout == "pending" && context.check.approval.stderr == "retry")', 'COMPLETE'),
      makeRule('when(true)', 'ABORT'),
    ];
    const state = await engineFor([step]).run();
    expect(state.status).toBe('completed');
    expect(state.systemContexts.get('check')).toEqual({ approval: { exit_code: 3, timed_out: false, stdout: 'pending', stderr: 'retry' } });
  });

  it.each([undefined, 'json'] as const)('only exposes JSON when output is %s', async (output) => {
    const step = commandStep(script('json', 'process.stdout.write(JSON.stringify({status: "approved"}));'), { output });
    const state = await engineFor([step]).run();
    expect(state.status).toBe('completed');
    const result = state.systemContexts.get('check')?.approval;
    expect(result).toMatchObject({ exit_code: 0, timed_out: false, stdout: '{"status":"approved"}', stderr: '' });
    if (output === 'json') expect(result).toHaveProperty('json', { status: 'approved' });
    else expect(result).not.toHaveProperty('json');
  });

  it('does not parse invalid JSON on a nonzero exit', async () => {
    const step = commandStep(script('invalid-nonzero', "process.stdout.write('not json'); process.exitCode = 1;"), { output: 'json' });
    step.rules = [makeRule('when(context.check.approval.exit_code == 1)', 'COMPLETE')];
    const state = await engineFor([step]).run();
    expect(state.status).toBe('completed');
    expect(state.systemContexts.get('check')?.approval).toEqual({ exit_code: 1, timed_out: false, stdout: 'not json', stderr: '' });
  });

  it.each([
    ['invalid JSON', "process.stdout.write('not json');", { output: 'json' as const }],
    ['stdout overflow', "process.stdout.write('x'.repeat(65537));", {}],
    ['UTF-8 byte overflow', "process.stdout.write('あ'.repeat(21846));", {}],
    ['combined stdout and stderr overflow', "process.stdout.write('x'.repeat(32768)); process.stderr.write('y'.repeat(32769));", {}],
  ])('fails on %s before effects or rules can run', async (_case, source, inputOptions) => {
    const step = commandStep(script('untrusted', source), inputOptions);
    step.effects = [{ type: 'caccia', pr: 123 }];
    step.rules = [makeRule('when(true)', 'after')];
    const effect = vi.fn().mockResolvedValue({ success: true });
    const after = makeStep({ name: 'after', kind: 'system', rules: [makeRule('when(true)', 'COMPLETE')] });
    const engine = engineFor([step, after], {}, {
      systemStepServicesFactory: (options) => createDefaultSystemStepServices({ ...options, cacciaService: { execute: effect } }),
    });
    const started: string[] = [];
    engine.on('step:start', (current) => started.push(current.name));
    const state = await engine.run();
    expect(state.status).toBe('aborted');
    expect(started).toEqual(['check']);
    expect(effect).not.toHaveBeenCalled();
  });

  it('accepts exactly 65536 bytes of combined output', async () => {
    const step = commandStep(script('boundary', "process.stdout.write('x'.repeat(32768)); process.stderr.write('y'.repeat(32768));"));
    const state = await engineFor([step]).run();
    expect(state.status).toBe('completed');
    expect(state.systemContexts.get('check')?.approval).toMatchObject({
      exit_code: 0, stdout: 'x'.repeat(32768), stderr: 'y'.repeat(32768),
    });
  });

  it('returns raw text without parsing JSON when output is omitted', async () => {
    const step = commandStep(script('plain-text', "process.stdout.write('not json');"));
    const state = await engineFor([step]).run();
    expect(state.status).toBe('completed');
    expect(state.systemContexts.get('check')?.approval).toEqual({ exit_code: 0, timed_out: false, stdout: 'not json', stderr: '' });
  });

  it('uses JSON to choose the next step and build its prompt', async () => {
    const step = commandStep(script('approved', 'process.stdout.write(JSON.stringify({status: "approved"}));'), { output: 'json' });
    step.rules = [makeRule('when(context.approval.json.status == "approved")', 'consume'), makeRule('when(true)', 'ABORT')];
    const promptLog = join(projectDir, 'prompts.jsonl');
    vi.stubEnv('TAKT_MOCK_PROMPT_LOG', promptLog);
    setMockScenario([{ status: 'done', content: 'Consumed' }]);
    const consume = makeStep({ name: 'consume', persona: 'consumer',
      instruction: 'Approval result: {context:check.approval.json.status}',
      rules: [makeRule('when(true)', 'COMPLETE')],
    });
    const state = await engineFor([step, consume]).run();
    expect(state.status).toBe('completed');
    const prompts = readFileSync(promptLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { prompt: string });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.prompt).toContain('Approval result: approved');
  });

  it('passes previous response and structured output as readable private files', async () => {
    const command = script('inspect-inputs', `
      import { readFileSync } from 'node:fs';
      const responsePath = process.env.TAKT_PREVIOUS_RESPONSE_FILE;
      const structuredPath = process.env.TAKT_PREVIOUS_STRUCTURED_OUTPUT_FILE;
      process.stdout.write(JSON.stringify({ responsePath, structuredPath,
        response: readFileSync(responsePath, 'utf8'),
        structured: JSON.parse(readFileSync(structuredPath, 'utf8')) }));
    `);
    const agent = makeStep({ name: 'prepare', persona: 'planner', instruction: 'Prepare approval',
      structuredOutput: { schemaRef: 'approval', schema: {
        type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: false,
      } },
      rules: [makeRule('when(true)', 'check')],
    });
    setMockScenario([{ status: 'done', content: 'approved', structuredOutput: { status: 'approved' } }]);
    const state = await engineFor([agent, commandStep(command, { output: 'json' })]).run();
    expect(state.status).toBe('completed');
    const result = state.systemContexts.get('check')?.approval as { json: { response: string; structured: unknown; responsePath: string; structuredPath: string } };
    expect(result.json).toMatchObject({ response: 'approved', structured: { status: 'approved' } });
    for (const path of [result.json.responsePath, result.json.structuredPath]) {
      const relativePath = relative(runsDir, path);
      expect(isAbsolute(relativePath) || relativePath.startsWith('..')).toBe(false);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(existsSync(path)).toBe(true);
    }
  });

  it('does not expand placeholders or execute previous response text', async () => {
    setMockScenario([{ status: 'done', content: '$(touch injected)' }]);
    const prepare = makeStep({ name: 'prepare', persona: 'planner', instruction: 'Prepare', rules: [makeRule('when(true)', 'check')] });
    const step = commandStep("printf '%s' '{previous_response}'");
    const state = await engineFor([prepare, step]).run();
    expect(state.status).toBe('completed');
    expect(state.systemContexts.get('check')?.approval).toMatchObject({ stdout: '{previous_response}' });
    expect(existsSync(join(executionDir, 'injected'))).toBe(false);
  });

  it('passes an empty response file without a structured file before any agent runs', async () => {
    const step = commandStep(script('empty-input', `
      import { readFileSync } from 'node:fs';
      process.stdout.write(JSON.stringify({ response: readFileSync(process.env.TAKT_PREVIOUS_RESPONSE_FILE, 'utf8'),
        structured: process.env.TAKT_PREVIOUS_STRUCTURED_OUTPUT_FILE ?? null }));
    `), { output: 'json' });
    const state = await engineFor([step]).run();
    expect(state.status).toBe('completed');
    expect(state.systemContexts.get('check')?.approval).toHaveProperty('json', { response: '', structured: null });
  });

  it('uses the immediately previous system response without reusing older structured output', async () => {
    setMockScenario([{ status: 'done', content: 'prepared', structuredOutput: { status: 'approved' } }]);
    const prepare = makeStep({ name: 'prepare', persona: 'planner', instruction: 'Prepare',
      structuredOutput: { schemaRef: 'approval', schema: {
        type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: false,
      } }, rules: [makeRule('when(true)', 'first')],
    });
    const command = script('inspect-previous', `
      import { readFileSync } from 'node:fs';
      process.stdout.write(JSON.stringify({ response: readFileSync(process.env.TAKT_PREVIOUS_RESPONSE_FILE, 'utf8'),
        structured: process.env.TAKT_PREVIOUS_STRUCTURED_OUTPUT_FILE ?? null }));
    `);
    const first = commandStep(command, { output: 'json' });
    first.name = 'first';
    first.rules = [makeRule('when(true)', 'second')];
    const second = commandStep(command, { output: 'json' });
    second.name = 'second';
    second.rules = [makeRule('when(true)', 'COMPLETE')];
    const state = await engineFor([prepare, first, second]).run();
    expect(state.status).toBe('completed');
    expect(state.systemContexts.get('first')?.approval).toHaveProperty('json.response', 'prepared');
    expect(state.systemContexts.get('first')?.approval).not.toHaveProperty('json.structured', null);
    expect(state.systemContexts.get('second')?.approval).toHaveProperty('json', {
      response: state.stepOutputs.get('first')?.content, structured: null,
    });
  });

  it.each(['clone', 'project'] as const)('executes in the task %s directory', async (target) => {
    const expected = target === 'clone' ? executionDir : projectDir;
    writeFileSync(join(expected, 'cwd.mjs'), 'process.stdout.write(process.cwd());');
    const step = commandStep('node cwd.mjs');
    const engine = target === 'clone'
      ? engineFor([step])
      : new WorkflowEngine({ name: 'root', initialStep: 'check', maxSteps: 1, steps: [step] }, projectDir, '', {
        provider: 'mock', projectCwd: projectDir, systemStepServicesFactory: createDefaultSystemStepServices,
        reportDirName: 'root-command', runPathsDirectory: runsDir,
      });
    if (target === 'project') engines.push(engine);
    const state = await engine.run();
    expect(state.status).toBe('completed');
    expect(state.systemContexts.get('check')?.approval).toMatchObject({ stdout: expected });
  });

  it('reruns a waiting command and counts the system step once', async () => {
    setMockScenario([{ status: 'done', content: 'approval request' }]);
    const prepare = makeStep({ name: 'prepare', persona: 'planner', instruction: 'Prepare', rules: [makeRule('when(true)', 'check')] });
    const step = commandStep(script('poll', `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      const n = existsSync('attempts') ? Number(readFileSync('attempts', 'utf8')) + 1 : 1;
      writeFileSync('attempts', String(n));
      const previous = readFileSync(process.env.TAKT_PREVIOUS_RESPONSE_FILE, 'utf8');
      const responses = existsSync('responses') ? JSON.parse(readFileSync('responses', 'utf8')) : [];
      writeFileSync('responses', JSON.stringify([...responses, previous]));
      process.stdout.write(JSON.stringify({ ready: n === 2 }));
    `), { output: 'json', timeout_ms: 1000 });
    if (step.kind !== 'system') throw new Error('Expected system step');
    step.wait = { until: 'when(context.check.approval.json.ready == true)', intervalMs: 1, maxRetries: 1, onTimeout: 'ABORT' };
    const state = await engineFor([prepare, step], { maxSteps: 2 }).run();
    expect(state.status).toBe('completed');
    expect(readFileSync(join(executionDir, 'attempts'), 'utf8')).toBe('2');
    expect(JSON.parse(readFileSync(join(executionDir, 'responses'), 'utf8'))).toEqual(['approval request', 'approval request']);
    expect(state.systemContexts.get('check')?.approval).toHaveProperty('json', { ready: true });
    expect(state.iteration).toBe(2);
  });

  it('drops JSON from an earlier wait attempt and follows on_timeout at the retry limit', async () => {
    const step = commandStep(script('stale-json', `
      import { existsSync, writeFileSync } from 'node:fs';
      if (existsSync('attempted')) { process.stdout.write('pending'); process.exitCode = 1; }
      else { writeFileSync('attempted', '1'); process.stdout.write('{"ready":false}'); }
    `), { output: 'json' });
    if (step.kind !== 'system') throw new Error('Expected system step');
    step.wait = { until: 'when(context.check.approval.exit_code == 7)', intervalMs: 1, maxRetries: 1, onTimeout: 'timeout' };
    const timeout = makeStep({ name: 'timeout', kind: 'system', rules: [makeRule('when(true)', 'COMPLETE')] });
    const state = await engineFor([step, timeout], { maxSteps: 2 }).run();
    expect(state.status).toBe('completed');
    expect(state.stepOutputs.has('timeout')).toBe(true);
    expect(state.systemContexts.get('check')?.approval).toEqual({ exit_code: 1, timed_out: false, stdout: 'pending', stderr: '' });
  });

  it('continues the same agent session after a command sends execution back', async () => {
    setMockScenario([
      { status: 'done', content: 'First', structuredOutput: { again: true } },
      { status: 'done', content: 'Second', structuredOutput: { again: false } },
    ]);
    const agent = makeStep({ name: 'agent', persona: 'planner', sessionKey: 'approval-session', instruction: 'Work',
      structuredOutput: { schemaRef: 'again', schema: {
        type: 'object', properties: { again: { type: 'boolean' } }, required: ['again'], additionalProperties: false,
      } },
      rules: [makeRule('when(structured.agent.again == false)', 'COMPLETE'), makeRule('when(true)', 'check')],
    });
    const step = commandStep(script('return', 'process.stdout.write("ok");'));
    step.rules = [makeRule('when(context.check.approval.exit_code == 0)', 'agent')];
    const engine = engineFor([agent, step], { maxSteps: 3 });
    const sessionIds: Array<string | undefined> = [];
    engine.on('step:complete', (current, response) => {
      if (current.name === 'agent') sessionIds.push(response.sessionId);
    });
    const state = await engine.run();
    expect(state.status).toBe('completed');
    expect(sessionIds).toHaveLength(2);
    expect(sessionIds[0]).toBeTruthy();
    expect(sessionIds[1]).toBe(sessionIds[0]);
    expect(state.iteration).toBe(3);
  });

  it('routes a timeout after stopping the child without parsing partial JSON', async () => {
    const step = commandStep(script('timeout', `
      import { writeFileSync } from 'node:fs';
      writeFileSync('child-pid', String(process.pid));
      process.stdout.write('partial JSON');
      process.on('SIGTERM', () => { writeFileSync('terminated', 'yes'); process.exit(0); });
      setTimeout(() => process.exit(90), 10000);
    `), { timeout_ms: 1000, output: 'json' });
    step.rules = [makeRule('when(context.check.approval.timed_out == true)', 'COMPLETE')];
    const state = await engineFor([step]).run();
    expect(state.status).toBe('completed');
    expect(state.systemContexts.get('check')?.approval).toMatchObject({ timed_out: true, stdout: 'partial JSON' });
    expect(state.systemContexts.get('check')?.approval).not.toHaveProperty('json');
    expect(readFileSync(join(executionDir, 'terminated'), 'utf8')).toBe('yes');
    const pid = Number(readFileSync(join(executionDir, 'child-pid'), 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 });
  });

  it('detects an agent and command system cycle with the existing loop monitor', async () => {
    setMockScenario([{ status: 'done', content: 'Repeat approval' }]);
    const agent = makeStep({ name: 'agent', persona: 'planner', instruction: 'Repeat', rules: [makeRule('when(true)', 'check')] });
    const check = commandStep(script('cycle', 'process.stdout.write("ok");'));
    check.rules = [makeRule('when(context.check.approval.exit_code == 0)', 'agent')];
    const finish = makeStep({ name: 'finish', kind: 'system', rules: [makeRule('when(true)', 'COMPLETE')] });
    const engine = engineFor([agent, check, finish], {
      maxSteps: 6,
      loopMonitors: [{ cycle: ['agent', 'check'], threshold: 1, judge: { rules: [{ ...makeRule('when(true)', 'finish'), next: 'finish' }] } }],
    });
    const detected = vi.fn();
    engine.on('step:cycle_detected', detected);
    const state = await engine.run();
    expect(state.status).toBe('completed');
    expect(detected).toHaveBeenCalledOnce();
    expect(state.stepOutputs.has('finish')).toBe(true);
  });

  it('stops the running child on engine abort without executing a following step', async () => {
    const step = commandStep(script('abort', `
      import { writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => { writeFileSync('terminated', 'yes'); process.exit(0); });
      writeFileSync('child-pid', String(process.pid));
      setTimeout(() => process.exit(90), 10000);
    `));
    step.rules = [makeRule('when(true)', 'after')];
    const after = makeStep({ name: 'after', kind: 'system', rules: [makeRule('when(true)', 'COMPLETE')] });
    const engine = engineFor([step, after]);
    const started: string[] = [];
    engine.on('step:start', (current) => started.push(current.name));
    let settled = false;
    const running = engine.run().finally(() => { settled = true; });
    await vi.waitFor(() => expect(existsSync(join(executionDir, 'child-pid')) || settled).toBe(true));
    engine.abort();
    const state = await running;
    expect(existsSync(join(executionDir, 'child-pid'))).toBe(true);
    expect(state.status).toBe('aborted');
    expect(started).toEqual(['check']);
    expect(readFileSync(join(executionDir, 'terminated'), 'utf8')).toBe('yes');
    const pid = Number(readFileSync(join(executionDir, 'child-pid'), 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 });
  });
});
