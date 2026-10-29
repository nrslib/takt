import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCommandInput } from '../infra/workflow/system/system-command-input.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import type { WorkflowSystemInput } from '../core/models/types.js';
import type { BoundedCommandResult } from '../shared/utils/bounded-command-runner.js';
import { resolveWorkflowSystemCommandsPolicy, validateWorkflowSystemCommands } from '../infra/config/loaders/workflowNormalizationPolicies.js';
import { normalizeWorkflowSystemCommandsPolicy, denormalizeWorkflowSystemCommandsPolicy } from '../infra/config/project/projectConfigTransforms.js';
import { WorkflowStepRawSchema } from '../core/models/index.js';

const doubles = vi.hoisted(() => ({ run: vi.fn(), directory: vi.fn(), file: vi.fn() }));
vi.mock('../shared/utils/bounded-command-runner.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../shared/utils/bounded-command-runner.js')>(),
  runBoundedCommand: doubles.run,
}));
vi.mock('../shared/utils/private-file.js', () => ({
  ensurePrivateDirectory: doubles.directory, writePrivateFile: doubles.file,
}));

describe('command system input adapter', () => {
  const input: Extract<WorkflowSystemInput, { type: 'command' }> = {
    type: 'command', as: 'approval', command: "printf '{previous_response}'", timeout_ms: 1000,
  };
  const options = { cwd: '/task', projectCwd: '/project', task: '', contextDirectory: '/run/context' };
  const state = () => createInitialState(
    { name: 'command', initialStep: 'check', maxSteps: 1, steps: [] },
    { projectCwd: '/project' },
  );
  const result: BoundedCommandResult = {
    exitCode: 0, timedOut: false, aborted: false,
    stdout: '{"ready":true}', stderr: '', outputLimitExceeded: false,
  };
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.run.mockResolvedValue({ ...result });
  });

  it('requires the run-owned directory before writing or executing', async () => {
    await expect(resolveCommandInput(input, { ...options, contextDirectory: undefined }, state())).rejects.toThrow('run context');
    expect(doubles.directory).not.toHaveBeenCalled();
    expect(doubles.run).not.toHaveBeenCalled();
  });

  it('writes an empty prior response and preserves command and cwd', async () => {
    expect(await resolveCommandInput(input, options, state())).toEqual({
      exit_code: 0, timed_out: false, stdout: result.stdout, stderr: '',
    });
    expect(doubles.file).toHaveBeenCalledWith(expect.stringMatching(/^\/run\/context\/system-commands\/.+\/response.txt$/), '');
    expect(doubles.run).toHaveBeenCalledWith(expect.objectContaining({
      command: input.command, cwd: '/task', timeoutMs: 1000,
    }));
    expect(doubles.run.mock.calls[0]?.[0].env).not.toHaveProperty('TAKT_PREVIOUS_STRUCTURED_OUTPUT_FILE');
  });

  it.each([
    { exitCode: 0, timedOut: false, expected: true },
    { exitCode: 1, timedOut: false, expected: false },
    { exitCode: 0, timedOut: true, expected: false },
  ])('exposes requested JSON only for successful non-timeout exit $exitCode/$timedOut', async ({ exitCode, timedOut, expected }) => {
    doubles.run.mockResolvedValue({ ...result, exitCode, timedOut });
    const resolved = await resolveCommandInput({ ...input, output: 'json' }, options, state());
    expect(resolved).toMatchObject({ exit_code: exitCode, timed_out: timedOut });
    if (expected) expect(resolved.json).toEqual({ ready: true });
    else expect(resolved).not.toHaveProperty('json');
  });

  it.each([
    { outputLimitExceeded: true, exitCode: 0 },
    { outputLimitExceeded: true, timedOut: true },
    { error: new Error('spawn failed') },
    { aborted: true },
    { stdout: 'invalid JSON' },
  ])('rejects an untrusted execution result %j', async (failure) => {
    doubles.run.mockResolvedValue({ ...result, ...failure });
    await expect(resolveCommandInput({ ...input, output: 'json' }, options, state())).rejects.toThrow();
  });
});

describe('system command permission conversion and validation', () => {
  it.each([true, false])('round trips explicit permission %s', (customScripts) => {
    expect(normalizeWorkflowSystemCommandsPolicy({ custom_scripts: customScripts })).toEqual({ customScripts });
    expect(denormalizeWorkflowSystemCommandsPolicy({ customScripts })).toEqual({ custom_scripts: customScripts });
  });
  it('preserves an absent policy', () => {
    expect(normalizeWorkflowSystemCommandsPolicy(undefined)).toBeUndefined();
    expect(denormalizeWorkflowSystemCommandsPolicy(undefined)).toBeUndefined();
    expect(resolveWorkflowSystemCommandsPolicy(undefined, undefined)).toBeUndefined();
  });
  it.each([
    [true, false, false], [false, true, true], [true, undefined, true],
  ])('prioritizes explicit project permission %s/%s', (global, project, expected) => {
    expect(resolveWorkflowSystemCommandsPolicy({ customScripts: global }, { customScripts: project }))
      .toEqual({ customScripts: expected });
  });
  it('rejects a command at loading and leaves existing inputs available', () => {
    const command = WorkflowStepRawSchema.parse({ name: 'check', kind: 'system',
      system_inputs: [{ type: 'command', as: 'result', command: 'fixed', timeout_ms: 1 }],
      rules: [{ condition: 'when(true)', next: 'COMPLETE' }],
    });
    expect(() => validateWorkflowSystemCommands([command], undefined)).toThrow('workflow_system_commands.custom_scripts');
    expect(() => validateWorkflowSystemCommands([command], { customScripts: true })).not.toThrow();
    const builtin = WorkflowStepRawSchema.parse({ name: 'check', kind: 'system',
      system_inputs: [{ type: 'task_context', as: 'task', source: 'current_task' }],
      rules: [{ condition: 'when(true)', next: 'COMPLETE' }],
    });
    expect(() => validateWorkflowSystemCommands([builtin], undefined)).not.toThrow();
  });

  it.each([
    { global: undefined, project: true, expected: true },
    { global: false, project: true, expected: true },
    { global: true, project: true, expected: true },
    { global: true, project: undefined, expected: true },
    { global: true, project: false, expected: false },
  ])('resolves project and global permission: $global/$project', ({ global, project, expected }) => {
    expect(resolveWorkflowSystemCommandsPolicy(
      global === undefined ? undefined : { customScripts: global },
      project === undefined ? undefined : { customScripts: project },
    )).toEqual({ customScripts: expected });
  });
});
