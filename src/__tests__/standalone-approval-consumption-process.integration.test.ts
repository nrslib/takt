import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { GoalQuestionSchema, type GoalQuestion } from '../infra/goals/schema.js';
import { StandaloneInquiryStore, type InquiryOwner } from '../infra/goals/standalone-inquiries.js';

const OutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), question: GoalQuestionSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

interface Consumer {
  child: ChildProcessWithoutNullStreams;
  prefix: string;
  completion: Promise<void>;
  closed: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  startupError?: string;
}

function startConsumer(input: {
  configDirectory: string;
  owner: InquiryOwner;
  approval: GoalQuestion;
  approvalPath: string;
  consumedAt: string;
  prefix: string;
  pausePublication: boolean;
}): Consumer {
  const script = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const input = JSON.parse(process.argv[1]);
const open = fs.openSync;
fs.openSync = (path, ...args) => {
  try {
    return open(path, ...args);
  } catch (error) {
    if (String(path) === input.approvalPath + '.lock' && args[0] === 'wx' && error.code === 'EEXIST') {
      fs.writeFileSync(input.prefix + '-contended', '');
    }
    throw error;
  }
};
const readSync = fs.readFileSync;
fs.readFileSync = (path, ...args) => {
  const content = readSync(path, ...args);
  if (String(path) === input.approvalPath) fs.writeFileSync(input.prefix + '-read', '');
  return content;
};
const read = fs.promises.readFile;
fs.promises.readFile = async (path, ...args) => {
  const content = await read(path, ...args);
  if (String(path) === input.approvalPath) fs.writeFileSync(input.prefix + '-read', '');
  return content;
};
const rename = fs.renameSync;
fs.renameSync = (source, target) => {
  if (input.pausePublication && String(target) === input.approvalPath) {
    fs.writeFileSync(input.prefix + '-saving', String(target));
    const deadline = Date.now() + 10000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(input.prefix + '-release')) {
      if (Date.now() >= deadline) throw new Error('Publication gate deadline exceeded');
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  return rename(source, target);
};
syncBuiltinESMExports();
const { StandaloneInquiryStore } = await import(${JSON.stringify(new URL('../infra/goals/standalone-inquiries.ts', import.meta.url).href)});
const store = new StandaloneInquiryStore(input.configDirectory, input.owner);
fs.writeFileSync(input.prefix + '-started', '');
try {
  const question = await store.consumeApproval(input.approval, input.consumedAt);
  process.stdout.write(JSON.stringify({ ok: true, question }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));
}
`;
  const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', script, JSON.stringify(input)], {
    env: { ...process.env, TAKT_CONFIG_DIR: input.configDirectory },
    stdio: 'pipe',
  });
  child.stdin.end();
  let finish!: () => void;
  const consumer: Consumer = {
    child, prefix: input.prefix, completion: new Promise<void>((resolve) => { finish = resolve; }),
    closed: false, code: null, signal: null, stdout: '', stderr: '',
  };
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { consumer.stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { consumer.stderr += chunk; });
  child.once('error', (error) => { consumer.startupError = String(error); });
  const deadline = setTimeout(() => { child.kill('SIGKILL'); }, 15_000);
  child.once('close', (code, signal) => {
    clearTimeout(deadline);
    consumer.closed = true;
    consumer.code = code;
    consumer.signal = signal;
    finish();
  });
  return consumer;
}

function diagnostics(consumer: Consumer) {
  return {
    pid: consumer.child.pid, code: consumer.code, signal: consumer.signal,
    stdout: consumer.stdout, stderr: consumer.stderr, startupError: consumer.startupError,
    contended: existsSync(consumer.prefix + '-contended'), read: existsSync(consumer.prefix + '-read'),
  };
}

async function waitForMarker(consumer: Consumer, suffix: string): Promise<void> {
  await vi.waitFor(() => {
    expect(existsSync(consumer.prefix + suffix), JSON.stringify(diagnostics(consumer))).toBe(true);
  }, { timeout: 5_000, interval: 10 });
}

describe('standalone once approval consumption across processes', () => {
  it.each(['workspace', 'repository'] as const)('allows only one consumer when %s publication overlaps another process', async (kind) => {
    const configDirectory = process.env.TAKT_CONFIG_DIR!;
    const repositoryDirectory = join(configDirectory, 'repository');
    await mkdir(repositoryDirectory, { recursive: true });
    const owner: InquiryOwner = kind === 'workspace'
      ? { kind, workspaceId: '750e8400-e29b-41d4-a716-446655440001' }
      : { kind, repositoryDirectory };
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const pending = await store.create({
      kind: 'approval', body: '出力を許可しますか',
      operation: { toolName: 'Write', args: '{"content":"hello"}', cwd: repositoryDirectory },
    });
    const approval = await store.answer(pending.id, { decision: 'allow', scope: 'once' });
    expect(approval.consumedAt).toBeUndefined();
    const approvalFiles = (await readdir(configDirectory, { recursive: true }))
      .filter((name) => name.endsWith(`${approval.id}.json`));
    expect(approvalFiles).toHaveLength(1);
    const approvalPath = join(configDirectory, approvalFiles[0]!);
    const consumers: Consumer[] = [];
    const first = startConsumer({ configDirectory, owner, approval, approvalPath, consumedAt: '2026-10-20T00:00:01.000Z',
      prefix: join(configDirectory, 'first'), pausePublication: true });
    consumers.push(first);
    try {
      await waitForMarker(first, '-started');
      await waitForMarker(first, '-saving');
      expect((await store.list())[0]!.consumedAt).toBeUndefined();
      const second = startConsumer({ configDirectory, owner, approval, approvalPath, consumedAt: '2026-10-20T00:00:02.000Z',
        prefix: join(configDirectory, 'second'), pausePublication: false });
      consumers.push(second);
      await waitForMarker(second, '-started');
      await vi.waitFor(() => {
        expect(existsSync(second.prefix + '-contended') || existsSync(second.prefix + '-read'),
          JSON.stringify(diagnostics(second))).toBe(true);
      }, { timeout: 5_000, interval: 10 });
      // 排他を通らない退行でも、後続の保存を先行公開の前に完了させて二重消費を観測する。
      if (!existsSync(second.prefix + '-contended')) {
        await second.completion;
      }
      writeFileSync(first.prefix + '-release', '');
      await Promise.all(consumers.map(({ completion }) => completion));
      console.info('standalone consumption processes', JSON.stringify({ kind, owner, approval,
        processes: consumers.map(diagnostics), saved: await store.list() }));
      for (const consumer of consumers) {
        expect(consumer.startupError, JSON.stringify(diagnostics(consumer))).toBeUndefined();
        expect(consumer.code, JSON.stringify(diagnostics(consumer))).toBe(0);
        expect(consumer.signal).toBeNull();
      }
      const outcomes = consumers.map(({ stdout }) => OutcomeSchema.parse(JSON.parse(stdout)));
      const saved = await store.list();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ id: approval.id, status: 'answered', operation: approval.operation,
        answer: { decision: 'allow', scope: 'once' } });
      const successful = outcomes.filter((outcome) => outcome.ok);
      for (const outcome of successful) {
        expect(outcome.question).toMatchObject({ id: approval.id, operation: approval.operation,
          consumedAt: expect.any(String) });
      }
      expect(successful.map(({ question }) => question.consumedAt)).toContain(saved[0]!.consumedAt);
      expect(successful).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(1);
    } finally {
      writeFileSync(first.prefix + '-release', '');
      for (const consumer of consumers) {
        if (!consumer.closed) consumer.child.kill('SIGKILL');
      }
      await Promise.all(consumers.map(({ completion }) => completion));
      const remaining = await readdir(configDirectory, { recursive: true });
      console.info('standalone consumption cleanup', JSON.stringify({ kind,
        closed: consumers.map(({ closed }) => closed), temporaryFiles: remaining.filter((name) => name.endsWith('.tmp')) }));
      expect(consumers.every(({ closed }) => closed)).toBe(true);
      expect(remaining.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    }
  }, 30_000);
});
