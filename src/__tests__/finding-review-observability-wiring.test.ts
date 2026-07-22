import { context, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig, WorkflowStep } from '../core/models/types.js';
import { runAgent } from '../agents/runner.js';
import { makeRule, makeStep } from './test-helpers.js';
import { initializeGitFixture } from './helpers/git-fixture.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

class CapturingSpanExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter['export']>[1]): void {
    this.spans.push(...spans);
    resultCallback({ code: 0 });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSnapshotIdEnum(schema: unknown): unknown[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    throw new Error('Expected raw findings schema properties');
  }
  const rawFindings = schema.properties.rawFindings;
  if (!isRecord(rawFindings) || !isRecord(rawFindings.items)) {
    throw new Error('Expected raw findings item schema');
  }
  const itemProperties = rawFindings.items.properties;
  if (!isRecord(itemProperties) || !isRecord(itemProperties.snapshotId)) {
    throw new Error('Expected raw findings snapshotId schema');
  }
  const snapshotIdEnum = itemProperties.snapshotId.enum;
  if (!Array.isArray(snapshotIdEnum)) {
    throw new Error('Expected raw findings snapshotId enum');
  }
  return snapshotIdEnum;
}

function hasSchemaProperty(schema: unknown, property: string): boolean {
  return isRecord(schema) && isRecord(schema.properties) && property in schema.properties;
}

function readSpanInstruction(span: ReadableSpan): string {
  const instruction = span.attributes['takt.phase.instruction'];
  if (typeof instruction !== 'string') {
    throw new Error(`Expected instruction on span ${span.name}`);
  }
  return instruction;
}

function readPromptSnapshotId(instruction: string): string {
  const snapshotId = instruction.match(/unchanged: ([0-9a-f]{64})\b/)?.[1];
  if (!snapshotId) {
    throw new Error('Expected reviewScopeSnapshotId in reviewer instruction');
  }
  return snapshotId;
}

function makeFindingContract() {
  return {
    ledgerPath: '.takt/findings/peer-review.json',
    rawFindingsPath: 'review-raw',
    manager: {
      persona: 'findings-manager',
      instruction: 'Reconcile findings.',
      outputContract: 'Return manager decisions.',
    },
  };
}

function makeSourceQuoteFinding(persona: string | undefined, schema: unknown): Record<string, unknown> {
  const snapshotId = readSnapshotIdEnum(schema)[1];
  if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
    throw new Error('Expected provider schema to require a non-empty snapshotId');
  }
  return {
    rawFindingId: `raw-${persona ?? 'reviewer'}`,
    familyTag: 'snapshot-ordering',
    severity: 'high',
    title: `Source quote from ${persona ?? 'reviewer'}`,
    location: 'src/reviewed.ts:1',
    description: 'The reviewer identified the tracked source line.',
    suggestion: 'Keep the finding for admission verification.',
    relation: 'new',
    targetFindingId: '',
    evidenceKind: 'source_quote',
    verbatimExcerpt: 'export const reviewed = true;',
    snapshotId,
  };
}

function readFindingLedger(cwd: string): {
  findings: unknown[];
  reviewerAnomalies?: Array<{ kind: string }>;
} {
  return JSON.parse(
    readFileSync(join(cwd, '.takt/findings/peer-review.json'), 'utf-8'),
  ) as {
    findings: unknown[];
    reviewerAnomalies?: Array<{ kind: string }>;
  };
}

function makeSingleReviewerConfig(): WorkflowConfig {
  return {
    name: 'single-reviewer-observability-wiring',
    maxSteps: 2,
    initialStep: 'review',
    findingContract: makeFindingContract(),
    steps: [makeStep({
      name: 'review',
      persona: 'reviewer',
      instruction: 'Review the implementation.',
      outputContracts: [
        { name: 'review.md', format: 'resolved facet body', formatRef: 'review-finding-contract' },
      ],
      rules: [makeRule('when(true)', 'COMPLETE')],
    })],
  };
}

function makeParallelReviewerConfig(): WorkflowConfig {
  return {
    name: 'parallel-reviewer-observability-wiring',
    maxSteps: 2,
    initialStep: 'reviewers',
    findingContract: makeFindingContract(),
    steps: [makeStep({
      name: 'reviewers',
      instruction: 'Run reviewers.',
      parallel: [
        makeStep({
          name: 'architecture-review',
          persona: 'architecture-reviewer',
          instruction: 'Review architecture.',
          rules: [makeRule('when(true)', 'COMPLETE')],
        }),
        makeStep({
          name: 'security-review',
          persona: 'security-reviewer',
          instruction: 'Review security.',
          rules: [makeRule('when(true)', 'COMPLETE')],
        }),
      ],
      rules: [makeRule('when(true)', 'COMPLETE')],
    })],
  };
}

describe('finding reviewer observability wiring', () => {
  const exporter = new CapturingSpanExporter();
  let sdk: NodeSDK;
  let WorkflowEngine: typeof import('../core/workflow/index.js').WorkflowEngine;
  let cwd: string;
  let configDir: string;
  let previousTaktConfigDir: string | undefined;

  beforeAll(async () => {
    trace.disable();
    context.disable();
    sdk = new NodeSDK({
      autoDetectResources: false,
      instrumentations: [],
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    sdk.start();
    ({ WorkflowEngine } = await import('../core/workflow/index.js'));
  });

  afterAll(async () => {
    await sdk.shutdown();
    trace.disable();
    context.disable();
  });

  beforeEach(() => {
    previousTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    configDir = join(tmpdir(), `takt-review-observability-config-${randomUUID()}`);
    cwd = join(tmpdir(), `takt-review-observability-${randomUUID()}`);
    process.env.TAKT_CONFIG_DIR = configDir;
    mkdirSync(dirname(join(cwd, 'src/reviewed.ts')), { recursive: true });
    writeFileSync(join(cwd, 'src/reviewed.ts'), 'export const reviewed = true;\n');
    initializeGitFixture(cwd, ['src/reviewed.ts']);
    exporter.spans.length = 0;
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (hasSchemaProperty(options?.outputSchema, 'rawFindings')) {
        return {
          persona,
          status: 'done',
          content: 'One finding.',
          structuredOutput: {
            rawFindings: [makeSourceQuoteFinding(persona, options?.outputSchema)],
          },
          timestamp: new Date('2026-07-22T00:00:00.000Z'),
        };
      }
      if (hasSchemaProperty(options?.outputSchema, 'rawDecisions')) {
        const rawFindingIds = [...instruction.matchAll(/"rawFindingId":\s*"([^"]+)"/g)]
          .map((match) => match[1])
          .filter((rawFindingId): rawFindingId is string => rawFindingId !== undefined);
        return {
          persona,
          status: 'done',
          content: 'Manager decisions.',
          structuredOutput: {
            rawDecisions: [...new Set(rawFindingIds)].map((rawFindingId) => ({
              rawFindingId,
              decision: 'new',
              findingId: '',
              evidence: 'No related open finding.',
            })),
            disputeDecisions: [],
            conflictDecisions: [],
            invalidateDecisions: [],
            duplicateDecisions: [],
            dismissDecisions: [],
          },
          timestamp: new Date('2026-07-22T00:00:01.000Z'),
        };
      }
      return {
        persona,
        status: 'done',
        content: 'Report complete.',
        timestamp: new Date('2026-07-22T00:00:02.000Z'),
      };
    });
  });

  afterEach(() => {
    if (existsSync(cwd)) {
      rmSync(cwd, { recursive: true, force: true });
    }
    if (existsSync(configDir)) {
      rmSync(configDir, { recursive: true, force: true });
    }
    if (previousTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousTaktConfigDir;
    }
  });

  it.each([
    { mode: 'full' as const },
    { mode: 'single' as const },
  ])('single reviewer shares prompt snapshot, schema enum, provider outputSchema, and real phase span in $mode mode', async ({ mode }) => {
    const engine = new WorkflowEngine(makeSingleReviewerConfig(), cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      observability: { enabled: true },
      sanitizeObservabilityText: (text) => text,
    });
    const startedSteps: WorkflowStep[] = [];
    const completedSteps: WorkflowStep[] = [];
    engine.on('step:start', (step) => startedSteps.push(step));
    engine.on('step:complete', (step) => completedSteps.push(step));

    if (mode === 'full') {
      await engine.run();
    } else {
      await engine.runSingleIteration();
    }

    const reviewerCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) =>
      hasSchemaProperty(options?.outputSchema, 'rawFindings'),
    );
    expect(reviewerCalls).toHaveLength(1);
    const [, providerPrompt, providerOptions] = reviewerCalls[0]!;
    const providerSchema = providerOptions?.outputSchema;
    const snapshotIdEnum = readSnapshotIdEnum(providerSchema);
    expect(snapshotIdEnum).toHaveLength(2);
    expect(snapshotIdEnum[0]).toBe('');
    expect(snapshotIdEnum[1]).toBe(readPromptSnapshotId(providerPrompt));
    expect(providerPrompt).toContain(JSON.stringify(providerSchema, null, 2));

    const phaseSpan = exporter.spans.find((span) =>
      span.name === 'phase.review.execute' && span.attributes['takt.phase.number'] === 1,
    );
    if (!phaseSpan) {
      throw new Error('Expected single reviewer phase span');
    }
    expect(readSpanInstruction(phaseSpan)).toBe(providerPrompt);

    if (mode === 'full') {
      expect(startedSteps).toHaveLength(1);
      expect(completedSteps).toHaveLength(1);
      expect(completedSteps[0]).toBe(startedSteps[0]);
    } else {
      expect(startedSteps).toHaveLength(0);
      expect(completedSteps).toHaveLength(0);
    }
    expect(existsSync(join(cwd, 'review-raw'))).toBe(true);
    const ledger = readFindingLedger(cwd);
    expect(ledger.findings).toHaveLength(1);
    expect(ledger.reviewerAnomalies ?? []).toHaveLength(0);
  });

  it('parallel reviewers expose real phase spans whose instructions match the shared provider schema snapshot', async () => {
    await new WorkflowEngine(makeParallelReviewerConfig(), cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      observability: { enabled: true },
      sanitizeObservabilityText: (text) => text,
    }).run();

    const reviewerCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) =>
      hasSchemaProperty(options?.outputSchema, 'rawFindings'),
    );
    expect(reviewerCalls).toHaveLength(2);
    const sharedProviderSchema = reviewerCalls[0]?.[2]?.outputSchema;
    const snapshotIdEnum = readSnapshotIdEnum(sharedProviderSchema);
    expect(snapshotIdEnum).toHaveLength(2);
    expect(snapshotIdEnum[0]).toBe('');

    for (const [persona, providerPrompt, providerOptions] of reviewerCalls) {
      expect(providerOptions?.outputSchema).toBe(sharedProviderSchema);
      expect(providerPrompt).toContain(JSON.stringify(sharedProviderSchema, null, 2));
      expect(snapshotIdEnum[1]).toBe(readPromptSnapshotId(providerPrompt));
      const stepName = persona === 'architecture-reviewer' ? 'architecture-review' : 'security-review';
      const phaseSpan = exporter.spans.find((span) =>
        span.name === `phase.${stepName}.execute` && span.attributes['takt.phase.number'] === 1,
      );
      if (!phaseSpan) {
        throw new Error(`Expected parallel reviewer phase span for ${stepName}`);
      }
      expect(readSpanInstruction(phaseSpan)).toBe(providerPrompt);
    }
    expect(existsSync(join(cwd, 'review-raw'))).toBe(true);
    const ledger = readFindingLedger(cwd);
    expect(ledger.findings).toHaveLength(2);
    expect(ledger.reviewerAnomalies ?? []).toHaveLength(0);
  });

  it('reviewer 実行中に source が変わると provider schema の旧 snapshot は stale として拒否される', async () => {
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (hasSchemaProperty(options?.outputSchema, 'rawFindings')) {
        const finding = makeSourceQuoteFinding(persona, options?.outputSchema);
        writeFileSync(join(cwd, 'src/reviewed.ts'), 'export const reviewed = false;\n');
        return {
          persona,
          status: 'done',
          content: 'One finding from the inspected snapshot.',
          structuredOutput: { rawFindings: [finding] },
          timestamp: new Date('2026-07-22T00:00:00.000Z'),
        };
      }
      return {
        persona,
        status: 'done',
        content: 'Report complete.',
        timestamp: new Date('2026-07-22T00:00:01.000Z'),
      };
    });

    await new WorkflowEngine(makeSingleReviewerConfig(), cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    }).runSingleIteration();

    const ledger = readFindingLedger(cwd);
    expect(ledger.findings).toHaveLength(0);
    expect(ledger.reviewerAnomalies).toEqual([
      expect.objectContaining({ kind: 'stale-snapshot' }),
    ]);
  });
});
