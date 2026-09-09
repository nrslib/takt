import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';

const RUN_SLUG = 'live-run';

interface IssueChild {
  readonly process: ChildProcess;
}

interface ChildMessage {
  readonly type: 'ready' | 'issued' | 'error';
  readonly instructionId?: number;
  readonly message?: string;
}

function createProjectDirectory(): string {
  const directory = join(tmpdir(), `takt-live-intervention-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function createStore(projectCwd: string): LiveInterventionFileStore {
  return new LiveInterventionFileStore(projectCwd, RUN_SLUG);
}

function issueEvent(instructionId: number, content: string, issuedAt: string): string {
  return JSON.stringify({
    type: 'issued',
    instructionId,
    issuedAt,
    content,
  });
}

function spawnConcurrentIssuer(
  projectCwd: string,
  content: string,
): IssueChild {
  const storeModuleUrl = pathToFileURL(
    resolve('src/infra/workflow/live-intervention-store.ts'),
  ).href;
  const script = `
    const { LiveInterventionFileStore } = await import(${JSON.stringify(storeModuleUrl)});
    const store = new LiveInterventionFileStore(${JSON.stringify(projectCwd)}, ${JSON.stringify(RUN_SLUG)});
    process.send?.({ type: 'ready' });
    process.on('message', async (message) => {
      if (message !== 'start') return;
      try {
        await store.issue(${JSON.stringify(content)});
        const instruction = store.read().instructions.find((entry) => entry.content === ${JSON.stringify(content)});
        if (instruction === undefined) {
          throw new Error('Issued instruction was not found');
        }
        process.send?.({ type: 'issued', instructionId: instruction.instructionId }, () => process.exit(0));
      } catch (error) {
        process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
      }
    });
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '--eval', script],
    {
      cwd: resolve('.'),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  return { process: child };
}

function waitForMessage(child: ChildProcess, expected: ChildMessage['type']): Promise<ChildMessage> {
  return new Promise((resolveMessage, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      callback();
    };
    const onMessage = (message: ChildMessage): void => {
      if (message.type !== expected) return;
      finish(() => resolveMessage(message));
    };
    const onError = (error: Error): void => finish(() => reject(error));
    const onExit = (code: number | null): void => {
      finish(() => reject(new Error(`issuer exited before ${expected}: ${code}`)));
    };
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

describe('LiveInterventionFileStore integration', () => {
  const projectDirectories: string[] = [];
  const childProcesses: ChildProcess[] = [];

  afterEach(() => {
    for (const child of childProcesses.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
    for (const directory of projectDirectories.splice(0)) {
      if (existsSync(directory)) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('stores a queue in projectCwd and lets a second store read the same ordered history', async () => {
    const projectCwd = createProjectDirectory();
    projectDirectories.push(projectCwd);
    const tuiStore = createStore(projectCwd);
    const engineStore = createStore(projectCwd);

    await tuiStore.issue('Aを追加して', '2026-09-03T00:00:00.000Z');
    await tuiStore.issue('さっきのAはやっぱりなし', '2026-09-03T00:00:01.000Z');

    expect(tuiStore.getFilePath()).toBe(
      join(projectCwd, '.takt', 'runs', RUN_SLUG, 'interventions.jsonl'),
    );
    expect(engineStore.getFilePath()).toBe(tuiStore.getFilePath());
    expect(engineStore.read()).toMatchObject({
      instructions: [
        expect.objectContaining({ instructionId: 1, content: 'Aを追加して', state: 'pending' }),
        expect.objectContaining({ instructionId: 2, content: 'さっきのAはやっぱりなし', state: 'pending' }),
      ],
      pending: 2,
      issuedTotal: 2,
    });
    expect(readFileSync(tuiStore.getFilePath(), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('recovers a killed lock holder while preserving a live holder', async () => {
    const projectCwd = createProjectDirectory();
    projectDirectories.push(projectCwd);
    const store = createStore(projectCwd);
    const lockPath = `${store.getFilePath()}.lock`;
    const lockModuleUrl = pathToFileURL(resolve('src/shared/utils/private-file-lock.ts')).href;
    const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', `
      const { runPrivateFileExclusive } = await import(${JSON.stringify(lockModuleUrl)});
      runPrivateFileExclusive(${JSON.stringify(lockPath)}, () => {
        process.send?.({ type: 'ready' });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });
    `], { cwd: resolve('.'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    childProcesses.push(child);
    await waitForMessage(child, 'ready');
    const lockContent = readFileSync(lockPath, 'utf8');
    let settled = false;
    const issuing = store.issue('after owner exit').then((id) => { settled = true; return id; });
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 30));
    expect(settled).toBe(false);
    expect(readFileSync(lockPath, 'utf8')).toBe(lockContent);
    const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    child.kill('SIGKILL');
    await exited;
    expect(await issuing).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
    expect(store.read().instructions[0]?.content).toBe('after owner exit');
  });

  it.each([
    { language: 'en' as const, heading: 'additional instructions from the user' },
    { language: 'ja' as const, heading: 'ユーザー' },
  ])('renders delivery guidance in $language', async ({ language, heading }) => {
    const projectCwd = createProjectDirectory();
    projectDirectories.push(projectCwd);
    const store = createStore(projectCwd);
    await store.issue('original instruction');
    const delivery = await store.prepareDelivery({ mode: 'same_session', step: 'review', phase: 1, language });
    expect(delivery.prompt).toContain(heading);
    expect(delivery.prompt).toContain('original instruction');
    expect(delivery.context).not.toHaveProperty('language');
  });

  it('commits only the pending IDs captured by delivery preparation', async () => {
    const projectCwd = createProjectDirectory();
    projectDirectories.push(projectCwd);
    const store = createStore(projectCwd);
    await store.issue('first', '2026-09-03T00:00:00.000Z');

    const prepared = await store.prepareDelivery({
      mode: 'same_session',
      step: 'implement',
      phase: 1,
    });
    await store.issue('issued after preparation', '2026-09-03T00:00:01.000Z');

    expect(prepared.instructionIds).toEqual([1]);
    expect(prepared.prompt.indexOf('first')).toBeGreaterThanOrEqual(0);
    expect(prepared.prompt).not.toContain('issued after preparation');

    await store.commitDelivery(prepared);
    expect(store.read()).toMatchObject({
      instructions: [
        expect.objectContaining({ instructionId: 1, state: 'deliveredSameSession' }),
        expect.objectContaining({ instructionId: 2, state: 'pending' }),
      ],
      pending: 1,
      deliveredSameSession: 1,
    });
  });

  it('validates events before appending them to the ledger', async () => {
    const projectCwd = createProjectDirectory();
    projectDirectories.push(projectCwd);
    const store = createStore(projectCwd);
    await store.issue('first', '2026-09-03T00:00:00.000Z');
    const before = readFileSync(store.getFilePath(), 'utf8');
    const prepared = await store.prepareDelivery({
      mode: 'same_session',
      step: 'implement',
      phase: 1,
    });

    await expect(store.commitDelivery({
      ...prepared,
      instructionIds: [],
    })).rejects.toThrow('instructionIds must not be empty');
    await expect(store.commitDelivery({
      ...prepared,
      instructionIds: [1, 1],
    })).rejects.toThrow('instructionIds must not contain duplicate IDs');
    await expect(store.issue('second', '')).rejects.toThrow('issuedAt must be a non-empty string');
    await expect(store.recordTerminal('completed', '')).rejects.toThrow('terminalAt must be a non-empty string');

    expect(readFileSync(store.getFilePath(), 'utf8')).toBe(before);
    expect(store.read()).toMatchObject({
      pending: 1,
      issuedTotal: 1,
      instructions: [expect.objectContaining({ instructionId: 1, state: 'pending' })],
    });
  });

  it.each([
    {
      mode: 'next_step' as const,
      context: { mode: 'next_step' as const, step: 'fix', phase: 1 as const },
      expectedState: 'deliveredNextStep',
    },
    {
      mode: 'batch_boundary' as const,
      context: {
        mode: 'batch_boundary' as const,
        step: 'process',
        phase: 1 as const,
        processedBatchCount: 2,
        runningBatchIndexes: [2, 3],
        appliesToBatchIndexes: [4, 5],
      },
      expectedState: 'deliveredNextStep',
    },
  ])('persists delivery metadata for $mode without replacing the history', async ({ context, expectedState }) => {
    const projectCwd = createProjectDirectory();
    projectDirectories.push(projectCwd);
    const store = createStore(projectCwd);
    await store.issue('opaque body', '2026-09-03T00:00:00.000Z');

    const prepared = await store.prepareDelivery(context);
    await store.commitDelivery(prepared);

    const events = readFileSync(store.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const delivery = events.at(-1);
    expect(delivery).toMatchObject({
      type: 'delivered',
      mode: context.mode,
      step: context.step,
      phase: context.phase,
      instructionIds: [1],
    });
    expect(delivery?.processedBatchCount).toBe(context.processedBatchCount);
    expect(delivery?.runningBatchIndexes).toEqual(context.runningBatchIndexes);
    expect(delivery?.appliesToBatchIndexes).toEqual(context.appliesToBatchIndexes);
    expect(store.read().instructions[0]).toMatchObject({
      instructionId: 1,
      content: 'opaque body',
      state: expectedState,
    });
  });

  it.each([
    `${issueEvent(1, 'first', '2026-09-03T00:00:00.000Z')}\n`
      + `${issueEvent(1, 'duplicate', '2026-09-03T00:00:01.000Z')}\n`,
    `${issueEvent(0, 'zero', '2026-09-03T00:00:00.000Z')}\n`,
    `${JSON.stringify({ type: 'issued', instructionId: 1.5, issuedAt: '2026-09-03T00:00:00.000Z', content: 'fraction' })}\n`,
    `${JSON.stringify({ type: 'delivered', instructionIds: [1], deliveredAt: '2026-09-03T00:00:00.000Z', mode: 'same_session', step: 'x', phase: 1 })}\n`,
    `${JSON.stringify({ type: 'delivered', instructionIds: null, deliveredAt: '2026-09-03T00:00:00.000Z', mode: 'same_session', step: 'x', phase: 1 })}\n`,
  ])('rejects malformed or impossible persisted events without replacing the file', async (rawContent) => {
    const projectCwd = createProjectDirectory();
    projectDirectories.push(projectCwd);
    const store = createStore(projectCwd);
    mkdirSync(dirname(store.getFilePath()), { recursive: true });
    writeFileSync(store.getFilePath(), rawContent, 'utf8');
    const before = readFileSync(store.getFilePath(), 'utf8');

    expect(() => store.read()).toThrow();
    expect(readFileSync(store.getFilePath(), 'utf8')).toBe(before);
  });

  it('keeps the issued history and records a warning state at both terminal outcomes', async () => {
    for (const status of ['completed', 'failed'] as const) {
      const projectCwd = createProjectDirectory();
      projectDirectories.push(projectCwd);
      const store = createStore(projectCwd);
      await store.issue('first', '2026-09-03T00:00:00.000Z');
      await store.issue('second', '2026-09-03T00:00:01.000Z');

      const unconsumedCount = await store.recordTerminal(status, '2026-09-03T00:00:02.000Z');
      expect(unconsumedCount).toBe(2);
      expect(await store.recordTerminal(status, '2026-09-03T00:00:03.000Z')).toBe(0);

      expect(store.read()).toMatchObject({
        terminalStatus: status,
        pending: 0,
        unconsumedWarned: 2,
        warned: true,
        instructions: [
          expect.objectContaining({ instructionId: 1, content: 'first', state: 'unconsumedWarned' }),
          expect.objectContaining({ instructionId: 2, content: 'second', state: 'unconsumedWarned' }),
        ],
      });
      expect(readFileSync(store.getFilePath(), 'utf8')).toContain('"type":"issued"');
    }
  });

  it('allocates distinct IDs for concurrent issuers after the existing maximum', async () => {
    const projectCwd = createProjectDirectory();
    projectDirectories.push(projectCwd);
    const store = createStore(projectCwd);
    for (let instructionId = 1; instructionId <= 7; instructionId += 1) {
      await store.issue(`seed-${instructionId}`, `2026-09-03T00:00:0${instructionId}.000Z`);
    }

    const children = [
      spawnConcurrentIssuer(projectCwd, 'from tui one'),
      spawnConcurrentIssuer(projectCwd, 'from tui two'),
    ];
    childProcesses.push(...children.map(({ process }) => process));
    await Promise.all(children.map(({ process }) => waitForMessage(process, 'ready')));
    for (const { process } of children) {
      process.send?.('start');
    }
    const results = await Promise.all(children.map(({ process }) => waitForMessage(process, 'issued')));

    expect(results.map((result) => result.instructionId).sort()).toEqual([8, 9]);
    const snapshot = store.read();
    expect(snapshot.instructions).toHaveLength(9);
    expect(snapshot.instructions.filter((instruction) => instruction.instructionId >= 8).map((instruction) => instruction.content).sort())
      .toEqual(['from tui one', 'from tui two']);
  });

  it('continues to use the project-side canonical file after a clone directory is removed', async () => {
    const projectCwd = createProjectDirectory();
    const cloneCwd = join(tmpdir(), `takt-live-clone-${process.pid}-${Date.now()}-${Math.random()}`);
    projectDirectories.push(projectCwd, cloneCwd);
    mkdirSync(cloneCwd, { recursive: true });
    const tuiStore = createStore(projectCwd);
    await tuiStore.issue('survives clone removal', '2026-09-03T00:00:00.000Z');

    rmSync(cloneCwd, { recursive: true, force: true });
    const reopenedEngineStore = createStore(projectCwd);

    expect(reopenedEngineStore.read().instructions).toEqual([
      expect.objectContaining({ content: 'survives clone removal', state: 'pending' }),
    ]);
  });
});
