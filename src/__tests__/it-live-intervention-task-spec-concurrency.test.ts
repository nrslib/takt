import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { persistDeliveredLiveInstructions } from '../features/tasks/execute/liveInterventionPersistence.js';
import { resolveTaskSpecForExecution, stageTaskSpecForExecution } from '../features/tasks/execute/taskSpecContext.js';
import { issueTellableRunningTask } from '../features/tasks/liveIntervention.js';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';

function monitorChildMessages(child: ChildProcess): (type: string) => Promise<void> {
  const messages: Array<Record<string, unknown>> = [];
  const waiters = new Map<string, () => void>();
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
  let rejectChild!: (error: Error) => void;
  const childFailure = new Promise<never>((_resolve, reject) => { rejectChild = reject; });
  // Observe failures between waits without consuming the rejection used by waitFor.
  void childFailure.catch(() => undefined);
  child.on('error', rejectChild);
  child.on('close', (code, signal) => {
    rejectChild(new Error(`Child closed before expected message (code: ${code}, signal: ${signal})\nstderr:\n${stderr}`));
  });
  child.on('message', (message: Record<string, unknown>) => {
    messages.push(message);
    if (message.type === 'error') rejectChild(new Error(String(message.message)));
    const type = String(message.type);
    waiters.get(type)?.();
    waiters.delete(type);
  });
  return (type: string) => {
    if (messages.some((message) => message.type === type)) return Promise.resolve();
    return Promise.race([
      new Promise<void>((resolveMessage) => { waiters.set(type, resolveMessage); }),
      childFailure,
    ]);
  };
}

describe('tell persistence across processes', () => {
  let project: string | undefined;
  let child: ChildProcess | undefined;
  afterEach(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    if (project !== undefined) rmSync(project, { recursive: true, force: true });
  });

  it.each([0, 1])('rejects a pending message wait with stderr when the child exits with code %s', async (code) => {
    child = spawn(process.execPath, ['--eval', `process.stderr.write('child startup failure', () => process.exit(${code}));`], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const waitFor = monitorChildMessages(child);

    await expect(waitFor('ready')).rejects.toThrow(`code: ${code}, signal: null)\nstderr:\nchild startup failure`);
  }, 5_000);

  it('reports the signal and stderr when the child terminates before ready', async () => {
    child = spawn(process.execPath, ['--eval', "process.stderr.write('terminated during startup', () => process.kill(process.pid, 'SIGTERM'));"], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const waitFor = monitorChildMessages(child);

    await expect(waitFor('ready')).rejects.toThrow('code: null, signal: SIGTERM)\nstderr:\nterminated during startup');
  }, 5_000);

  it('preserves received messages and rejects missing messages when waiting starts after close', async () => {
    child = spawn(process.execPath, ['--eval', "process.send({ type: 'ready' }, () => process.stderr.write('closed after ready', () => process.exit(1)));"], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const waitFor = monitorChildMessages(child);
    await once(child, 'close');
    // Give Node a turn to report an unhandled rejection before starting any message wait.
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

    await expect(waitFor('ready')).resolves.toBeUndefined();
    await expect(waitFor('issued')).rejects.toThrow('code: 1, signal: null)\nstderr:\nclosed after ready');
  }, 5_000);

  it.each([false, true])('retains all delivered instructions when issuing overlaps publication: %s', async (overlap) => {
    project = mkdtempSync(join(tmpdir(), 'takt-tell-concurrency-'));
    const clone = join(project, '.takt/worktrees/clone');
    const taskDir = '.takt/tasks/tell';
    const slug = 'concurrent-run';
    const paths = buildRunPaths(clone, slug);
    mkdirSync(clone, { recursive: true });
    mkdirSync(join(project, taskDir), { recursive: true });
    mkdirSync(paths.runRootAbs, { recursive: true });
    writeFileSync(join(project, taskDir, 'order.md'), '# Original\n');
    writeFileSync(join(project, '.takt/tasks.yaml'), stringify({ tasks: [{
      name: 'tell', status: 'running', task_dir: taskDir, worktree: true, worktree_path: clone,
      branch: 'feature/tell', run_slug: slug, created_at: '2026-10-18T00:00:00Z',
      started_at: '2026-10-18T00:00:00Z', completed_at: null,
    }] }));
    writeFileSync(paths.metaAbs, JSON.stringify({
      task: 'tell', workflow: 'test', runSlug: slug, status: 'running',
      runRoot: paths.runRootRel, reportDirectory: paths.reportsRel,
      contextDirectory: paths.contextRel, logsDirectory: paths.logsRel, startTime: '2026-10-18T00:00:00Z',
    }));
    const spec = resolveTaskSpecForExecution(project, clone, taskDir, slug);
    stageTaskSpecForExecution(spec, paths);
    const moduleUrl = pathToFileURL(resolve('src/features/tasks/liveIntervention.ts')).href;
    child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const lstat = fs.lstatSync;
      let observedLock = false;
      fs.lstatSync = (target, ...args) => {
        const result = lstat(target, ...args);
        if (!observedLock && String(target) === ${JSON.stringify(join(project, '.takt/runs', slug, 'interventions.jsonl.lock'))}) {
          observedLock = true;
          process.send({ type: 'waiting' });
        }
        return result;
      };
      syncBuiltinESMExports();
      const { issueTellableRunningTask } = await import(${JSON.stringify(moduleUrl)});
      process.send({ type: 'ready' });
      process.once('message', async () => {
        try {
          const result = await issueTellableRunningTask(${JSON.stringify(project)}, ${JSON.stringify(slug)}, 'second instruction');
          process.send({ type: 'issued', id: result.instructionId }, () => process.exit(0));
        } catch (error) {
          process.send({ type: 'error', message: String(error) }, () => process.exit(1));
        }
      });
    `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const processChild = child;
    const waitFor = monitorChildMessages(processChild);
    await waitFor('ready');
    await issueTellableRunningTask(project, slug, 'first instruction');
    let release!: () => void;
    const publication = new Promise<void>((resolveGate) => { release = resolveGate; });
    let entered!: () => void;
    const saving = new Promise<void>((resolveGate) => { entered = resolveGate; });
    let first = true;
    const store = new LiveInterventionFileStore(project, slug, async (instructions) => {
      if (first) {
        first = false;
        entered();
        await publication;
      }
      persistDeliveredLiveInstructions(project!, clone, spec, paths, instructions);
    });
    const commit = store.commitDelivery(await store.prepareDelivery({ mode: 'next_step', step: 'review', phase: 1 }));
    await saving;
    expect(readFileSync(paths.contextTaskOrderAbs, 'utf8')).toBe('# Original\n');
    expect(existsSync(`${store.getFilePath()}.lock`)).toBe(true);
    if (overlap) {
      processChild.send('start');
      await waitFor('waiting');
      expect(store.read().issuedTotal).toBe(1);
    }
    release();
    await commit;
    if (!overlap) processChild.send('start');
    await waitFor('issued');
    if (processChild.exitCode === null) await once(processChild, 'exit');
    expect(processChild.exitCode).toBe(0);
    await store.commitDelivery(await store.prepareDelivery({ mode: 'next_step', step: 'verify', phase: 1 }));
    const source = readFileSync(join(project, taskDir, 'order.md'), 'utf8');
    const laterAgentRead = readFileSync(paths.contextTaskOrderAbs, 'utf8');
    expect(laterAgentRead).toBe(source);
    expect(source.startsWith('# Original\n')).toBe(true);
    expect(store.read()).toMatchObject({ issuedTotal: 2, pending: 0, deliveredNextStep: 2 });
    for (const instruction of store.read().instructions) {
      expect(source).toContain(instruction.content);
      expect(source).toContain(`instructionId: ${instruction.instructionId}`);
      expect(source).toContain(instruction.issuedAt);
    }
  }, 20_000);
});
