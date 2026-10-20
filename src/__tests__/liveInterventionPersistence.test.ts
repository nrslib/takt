import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { persistDeliveredLiveInstructions } from '../features/tasks/execute/liveInterventionPersistence.js';
import { resolveTaskSpecForExecution, restageTaskSpecForExecution, type ResolvedTaskSpec } from '../features/tasks/execute/taskSpecContext.js';

vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  lstatSync: vi.fn(), openSync: vi.fn(), fstatSync: vi.fn(), appendFileSync: vi.fn(), closeSync: vi.fn(),
}));
vi.mock('../features/tasks/execute/taskSpecContext.js', () => ({
  resolveTaskSpecForExecution: vi.fn(), restageTaskSpecForExecution: vi.fn(),
}));

const paths = buildRunPaths('/clone', 'run-a');
const spec: ResolvedTaskSpec = {
  runSlug: 'run-a', sourceTaskDir: '/project/.takt/tasks/task-a', attachmentManifest: [],
  taskPrompt: 'Read the spec', orderContent: 'original', stagedOrderContent: 'original',
};
const instructions = [{ instructionId: 7, issuedAt: '2026-10-18T01:00:00.000Z', content: '追加本文  ' }];

describe('persistDeliveredLiveInstructions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fs.lstatSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof fs.lstatSync>);
    vi.mocked(fs.fstatSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof fs.fstatSync>);
    vi.mocked(fs.openSync).mockReturnValue(123);
    vi.mocked(resolveTaskSpecForExecution).mockReturnValue(spec);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('appends the delivered body with its original ID and receipt time and refreshes through staging', () => {
    persistDeliveredLiveInstructions('/project', '/clone', spec, paths, instructions);
    expect(fs.appendFileSync).toHaveBeenCalledOnce();
    const [descriptor, appended, encoding] = vi.mocked(fs.appendFileSync).mock.calls[0]!;
    expect(descriptor).toBe(123);
    expect(encoding).toBe('utf-8');
    expect(String(appended)).toContain('追加の指示');
    expect(String(appended)).toMatch(/\b7\b/);
    expect(String(appended)).toContain(instructions[0]!.issuedAt);
    expect(String(appended)).toContain(instructions[0]!.content);
    expect(fs.closeSync).toHaveBeenCalledWith(123);
    expect(resolveTaskSpecForExecution).toHaveBeenCalledWith('/project', '/clone', '.takt/tasks/task-a', 'run-a', paths);
    expect(restageTaskSpecForExecution).toHaveBeenCalledWith(spec, paths);
  });

  it('warns about a missing source spec without writing either order file', () => {
    expect(() => persistDeliveredLiveInstructions('/project', '/clone', undefined, paths, instructions)).not.toThrow();
    expect(fs.appendFileSync).not.toHaveBeenCalled();
    expect(restageTaskSpecForExecution).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledOnce();
  });

  it('closes a failed append and continues with the next delivered instruction', () => {
    vi.mocked(fs.appendFileSync).mockImplementationOnce(() => { throw new Error('append failed'); });
    persistDeliveredLiveInstructions('/project', '/clone', spec, paths, [
      ...instructions, { instructionId: 8, issuedAt: 'later', content: '次の指示' },
    ]);
    expect(fs.closeSync).toHaveBeenCalledTimes(2);
    expect(fs.appendFileSync).toHaveBeenCalledTimes(2);
    expect(restageTaskSpecForExecution).toHaveBeenCalledOnce();
    expect(process.stderr.write).toHaveBeenCalledOnce();
  });

  it('keeps a successful source append when publication fails and warns without throwing', () => {
    vi.mocked(restageTaskSpecForExecution).mockImplementationOnce(() => { throw new Error('publication failed'); });
    expect(() => persistDeliveredLiveInstructions('/project', '/clone', spec, paths, instructions)).not.toThrow();
    expect(fs.appendFileSync).toHaveBeenCalledOnce();
    expect(process.stderr.write).toHaveBeenCalledOnce();
  });
});
