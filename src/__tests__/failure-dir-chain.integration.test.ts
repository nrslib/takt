import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowConfig } from '../core/models/index.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { MAX_AGENT_FAILURE_MESSAGE_BYTES } from '../shared/types/agent-failure.js';

const PARSE_FAILURE_DETAIL = `Failed to parse item: ${'x'.repeat(12_000)}`;
let codexCallCount = 0;

function createThrowingEvents(): AsyncGenerator<never> {
  return (async function* () {
    throw new Error(PARSE_FAILURE_DETAIL);
  })();
}

vi.mock('@openai/codex-sdk', () => ({
  Codex: class MockCodex {
    async startThread() {
      return {
        id: 'thread-1',
        runStreamed: async () => {
          codexCallCount += 1;
          return { events: createThrowingEvents() };
        },
      };
    }

    async resumeThread(threadId: string) {
      return {
        id: threadId,
        runStreamed: async () => {
          codexCallCount += 1;
          return { events: createThrowingEvents() };
        },
      };
    }
  },
}));

function createWorkflowConfig(): WorkflowConfig {
  return {
    name: 'failure-dir-chain',
    description: 'Codex failure directory chain test',
    initialStep: 'work',
    maxSteps: 1,
    steps: [{
      name: 'work',
      persona: 'coder',
      personaDisplayName: 'Coder',
      instruction: 'Execute the task',
      provider: 'codex',
      model: 'gpt-5',
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
    }],
  };
}

describe('failureDir propagation through the complete Codex workflow chain', () => {
  let projectCwd: string;

  beforeEach(() => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-failure-dir-chain-'));
    codexCallCount = 0;
  });

  afterEach(() => {
    rmSync(projectCwd, { recursive: true, force: true });
  });

  it('persists oversized SDK parse failures and aborts as step_error without retrying', async () => {
    const engine = new WorkflowEngine(
      createWorkflowConfig(),
      projectCwd,
      'Trigger a provider parse failure',
      {
        projectCwd,
        provider: 'codex',
        model: 'gpt-5',
        reportDirName: 'failure-dir-chain',
      },
    );
    let abortKind: string | undefined;
    let abortReason: string | undefined;
    let abortFailureError: string | undefined;
    engine.on('workflow:abort', (_state, reason, kind, failure) => {
      abortReason = reason;
      abortKind = kind;
      abortFailureError = failure.error;
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortKind).toBe('step_error');
    expect(abortReason).toContain('provider stream parse error');
    expect(abortReason).toContain('[TRUNCATED:');
    expect(abortReason).toContain('.takt/runs/failure-dir-chain/failures/');
    expect(abortFailureError).toBe(abortReason);
    expect(Buffer.byteLength(abortReason ?? '')).toBeLessThanOrEqual(MAX_AGENT_FAILURE_MESSAGE_BYTES);
    expect(Buffer.byteLength(abortFailureError ?? '')).toBeLessThanOrEqual(MAX_AGENT_FAILURE_MESSAGE_BYTES);
    expect(abortReason).not.toContain('Step execution failed:');
    expect(codexCallCount).toBe(1);

    const failureDir = join(projectCwd, '.takt', 'runs', 'failure-dir-chain', 'failures');
    const failureFiles = readdirSync(failureDir);
    const expectedFullText = `provider stream parse error: ${PARSE_FAILURE_DETAIL}`;

    expect(failureFiles).toHaveLength(1);
    const failureFile = failureFiles[0];
    expect(failureFile).toBeDefined();
    if (failureFile === undefined) {
      throw new Error('Expected one persisted failure file');
    }
    const failurePath = join(failureDir, failureFile);
    expect(readFileSync(failurePath, 'utf8')).toBe(expectedFullText);
    expect(statSync(failurePath).mode & 0o777).toBe(0o600);
  });
});
