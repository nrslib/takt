import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GoalQuestionSchema } from '../infra/goals/schema.js';
import type { InquiryOwner } from '../infra/goals/standalone-inquiries.js';

const storeModule = new URL('../infra/goals/standalone-inquiries.ts', import.meta.url).href;

async function runStoreProcess(source: string, config: string, owner: InquiryOwner): Promise<unknown> {
  const script = `
    import { StandaloneInquiryStore } from ${JSON.stringify(storeModule)};
    const [config, owner] = process.argv.slice(1);
    const store = new StandaloneInquiryStore(config, JSON.parse(owner));
    ${source}
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, config, JSON.stringify(owner)], {
    env: { ...process.env, TAKT_CONFIG_DIR: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errorOutput = '';
  let startFailure: Error | undefined;
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { errorOutput += data.toString(); });
  child.once('error', (error) => { startFailure = error; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('close', (code, signal) => {
        if (startFailure !== undefined) reject(startFailure);
        else if (code !== 0) reject(new Error(`Store process exited with code ${code}, signal ${signal}: ${errorOutput}`));
        else resolve();
      });
    });
    return JSON.parse(output);
  } finally {
    clearTimeout(timer);
  }
}

describe('standalone inquiry persistence across processes', () => {
  it.each(['workspace', 'repository'] as const)('restores pending inquiries after the %s writer exits and isolates other owners', async (kind) => {
    const config = process.env.TAKT_CONFIG_DIR!;
    const repository = join(config, 'repository');
    const otherRepository = join(config, 'other-repository');
    await mkdir(repository, { recursive: true });
    await mkdir(otherRepository, { recursive: true });
    const owner: InquiryOwner = kind === 'workspace'
      ? { kind, workspaceId: '750e8400-e29b-41d4-a716-446655440001' }
      : { kind, repositoryDirectory: repository };
    const otherOwner: InquiryOwner = kind === 'workspace'
      ? { kind, workspaceId: '750e8400-e29b-41d4-a716-446655440002' }
      : { kind, repositoryDirectory: otherRepository };
    const body = `${kind}の相談`;
    const written = GoalQuestionSchema.parse(await runStoreProcess(
      `const question = await store.create({ body: ${JSON.stringify(body)} }); process.stdout.write(JSON.stringify(question));`,
      config, owner,
    ));

    const reader = 'process.stdout.write(JSON.stringify(await store.listPending()));';
    expect(await runStoreProcess(reader, config, otherOwner)).toEqual([]);
    expect(await runStoreProcess(reader, config, owner)).toEqual([
      expect.objectContaining({ id: written.id, body, status: 'pending' }),
    ]);
  }, 30_000);
});
