/**
 * E2E: SIGINT while mock provider is in the middle of a slow "AI response"
 *
 * Verifies that Ctrl+C interrupts task execution even when the provider
 * is actively processing (simulated by delay_ms in the mock scenario).
 * The process should exit well before the mock's 30s delay completes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { cleanupChildProcess, cleanupTestResource, waitFor, waitForClose } from '../helpers/wait.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('E2E: SIGINT while waiting for AI output (mock with delay)', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;
  let child: ReturnType<typeof spawn> | undefined;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createTestRepo();

    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-model',
      concurrency: 1,
      task_poll_interval_ms: 100,
    });
  });

  afterEach(async () => {
    await cleanupChildProcess(child);
    child = undefined;
    cleanupTestResource('testRepo', () => testRepo.cleanup());
    cleanupTestResource('isolatedEnv', () => isolatedEnv.cleanup());
  });

  it('should exit promptly when SIGINT fires during mock provider delay (30s)', async () => {
    const binPath = resolve(__dirname, '../../bin/takt');
    const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/sigint-ai-wait.json');

    const tasksFile = join(testRepo.path, '.takt', 'tasks.yaml');
    mkdirSync(join(testRepo.path, '.takt'), { recursive: true });

    const now = new Date().toISOString();
    writeFileSync(
      tasksFile,
      [
        'tasks:',
        '  - name: ai-wait-task',
        '    status: pending',
        '    content: "E2E SIGINT during AI wait"',
        `    workflow: "${workflowPath}"`,
        `    created_at: "${now}"`,
        '    started_at: null',
        '    completed_at: null',
        '    owner_pid: null',
      ].join('\n'),
      'utf-8',
    );

    child = spawn('node', [binPath, 'run', '--provider', 'mock'], {
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    // Wait for the task to start executing (=== Task: ai-wait-task ===)
    const taskStarted = await waitFor(
      () => stdout.includes('=== Task: ai-wait-task ==='),
      15_000,
    );
    expect(taskStarted, `Task did not start.\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(true);

    // Give a moment for the mock delay to begin inside callMock
    await new Promise((r) => setTimeout(r, 300));

    // Send SIGINT (simulates user pressing Ctrl+C)
    child.kill('SIGINT');

    // Process must exit well before the 30s mock delay — allow up to 8s
    const start = Date.now();
    const exit = await waitForClose(child, 8_000);
    const elapsed = Date.now() - start;

    expect(
      exit.signal === 'SIGINT' || exit.code === 130 || exit.code === 0,
      `Unexpected exit: code=${exit.code}, signal=${exit.signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    ).toBe(true);

    // Should have exited fast — much less than the 30s delay
    expect(elapsed, `Process took ${elapsed}ms to exit after SIGINT — too slow`).toBeLessThan(7_000);
  }, 60_000);
});
