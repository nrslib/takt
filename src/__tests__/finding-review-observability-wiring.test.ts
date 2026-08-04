import { context, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig, WorkflowStep } from '../core/models/types.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { runAgent } from '../agents/runner.js';
import { makeRule, makeStep } from './test-helpers.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { reviewerRawExtractionFixture } from './helpers/finding-lifecycle-fixture.js';

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

function makeFindingContract() {
  return {
    manager: {
      persona: 'findings-manager',
      instruction: 'Reconcile findings.',
      outputContract: 'Return manager decisions.',
    },
  };
}

function makeSourceQuoteFinding(persona: string | undefined, schema: unknown): Record<string, unknown> {
  if (JSON.stringify(schema).includes('"snapshotId"')) {
    throw new Error('Reviewer schema must not expose engine-issued snapshotId');
  }
  return reviewerRawExtractionFixture({
    rawFindingId: `raw-${persona ?? 'reviewer'}`,
    familyTag: 'snapshot-ordering',
    severity: 'high',
    title: `Source quote from ${persona ?? 'reviewer'}`,
    description: 'The reviewer identified the tracked source line.',
    suggestion: 'Keep the finding for admission verification.',
    relation: 'new',
    targetFindingId: null,
    evidence: [{
      kind: 'file_quote',
      path: 'src/reviewed.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'export const reviewed = true;',
      snapshotId: '0'.repeat(64),
    }],
    rawExcerpt: 'One finding.',
  });
}

function readFindingLedger(cwd: string, workflowName: string): {
  findings: Array<{ title: string; evidenceIds: string[] }>;
  evidenceRecords: Array<{ evidenceId: string; kind: string }>;
  reviewerAnomalies?: Array<{ kind: string }>;
} {
  return createTestFindingLedgerStore({
    projectCwd: cwd,
    runId: 'test-report-dir',
    reportDir: buildRunPaths(cwd, 'test-report-dir').reportsAbs,
    workflowName,
  }).loadLedger() as {
    findings: Array<{ title: string; evidenceIds: string[] }>;
    evidenceRecords: Array<{ evidenceId: string; kind: string }>;
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
          outputContracts: [
            {
              name: 'architecture-review.md',
              format: 'resolved facet body',
              formatRef: 'review-finding-contract',
            },
          ],
          rules: [makeRule('when(true)', 'COMPLETE')],
        }),
        makeStep({
          name: 'security-review',
          persona: 'security-reviewer',
          instruction: 'Review security.',
          outputContracts: [
            {
              name: 'security-review.md',
              format: 'resolved facet body',
              formatRef: 'review-finding-contract',
            },
          ],
          rules: [makeRule('when(true)', 'COMPLETE')],
        }),
      ],
      rules: [makeRule('when(true)', 'COMPLETE')],
    })],
  };
}

function createTestFindingAuthorityResolver(config: WorkflowConfig, cwd: string) {
  const contract = config.findingContract;
  if (contract === undefined) {
    throw new Error('Expected Finding Contract');
  }
  const store = createTestFindingLedgerStore({
    projectCwd: cwd,
    runId: 'test-report-dir',
    reportDir: buildRunPaths(cwd, 'test-report-dir').reportsAbs,
    workflowName: config.name,
  });
  return {
    resolve: () => store,
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
        const finding = makeSourceQuoteFinding(persona, options?.outputSchema);
        const reportContent = String(finding.rawExcerpt);
        return {
          persona,
          status: 'done',
          content: reportContent,
          structuredOutput: {
            ...(hasSchemaProperty(options?.outputSchema, 'reportContent')
              ? { reportContent }
              : {}),
            rawFindings: [finding],
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
              anchorRelevance: 'relevant',
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
  ])('single reviewer keeps engine proof fields out of provider schema and exposes the real phase span in $mode mode', async ({ mode }) => {
    const config = makeSingleReviewerConfig();
    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      findingAuthorityResolver: createTestFindingAuthorityResolver(config, cwd),
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
      hasSchemaProperty(options?.outputSchema, 'rawFindings')
      && !hasSchemaProperty(options?.outputSchema, 'reportContent'),
    );
    expect(reviewerCalls).toHaveLength(1);
    const [, providerPrompt, providerOptions] = reviewerCalls[0]!;
    const providerSchema = providerOptions?.outputSchema;
    expect(JSON.stringify(providerSchema)).not.toContain('"snapshotId"');
    expect(providerPrompt).toContain('Do not output proofId, snapshotId, runId');
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
    expect(existsSync(join(
      buildRunPaths(cwd, 'test-report-dir').reportsAbs,
      'raw-findings.review.json',
    ))).toBe(true);
    const ledger = readFindingLedger(cwd, config.name);
    expect(ledger.findings).toHaveLength(1);
    expect(ledger.reviewerAnomalies ?? []).toHaveLength(0);
  });

  it('parallel reviewers share the request-only provider schema and expose matching real phase spans', async () => {
    const config = makeParallelReviewerConfig();
    await new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      findingAuthorityResolver: createTestFindingAuthorityResolver(config, cwd),
      observability: { enabled: true },
      sanitizeObservabilityText: (text) => text,
    }).run();

    const reviewerCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) =>
      hasSchemaProperty(options?.outputSchema, 'rawFindings')
      && !hasSchemaProperty(options?.outputSchema, 'reportContent'),
    );
    expect(reviewerCalls).toHaveLength(2);
    const sharedProviderSchema = reviewerCalls[0]?.[2]?.outputSchema;
    expect(JSON.stringify(sharedProviderSchema)).not.toContain('"snapshotId"');

    for (const [persona, providerPrompt, providerOptions] of reviewerCalls) {
      expect(providerOptions?.outputSchema).toBe(sharedProviderSchema);
      expect(providerPrompt).toContain(JSON.stringify(sharedProviderSchema, null, 2));
      expect(providerPrompt).toContain('Do not output proofId, snapshotId, runId');
      const stepName = persona === 'architecture-reviewer' ? 'architecture-review' : 'security-review';
      const phaseSpan = exporter.spans.find((span) =>
        span.name === `phase.${stepName}.execute` && span.attributes['takt.phase.number'] === 1,
      );
      if (!phaseSpan) {
        throw new Error(`Expected parallel reviewer phase span for ${stepName}`);
      }
      expect(readSpanInstruction(phaseSpan)).toBe(providerPrompt);
    }
    expect(existsSync(join(
      buildRunPaths(cwd, 'test-report-dir').reportsAbs,
      'raw-findings.reviewers.json',
    ))).toBe(true);
    const ledger = readFindingLedger(cwd, config.name);
    expect(ledger.findings).toHaveLength(2);
    const evidenceKindById = new Map(
      ledger.evidenceRecords.map((record) => [record.evidenceId, record.kind]),
    );
    expect(ledger.findings.map((finding) => (
      finding.evidenceIds.map((evidenceId) => evidenceKindById.get(evidenceId)).sort()
    ))).toEqual([
      ['engine_proof', 'file_quote'],
      ['engine_proof', 'file_quote'],
    ]);
    expect(new Set(ledger.findings.flatMap((finding) => finding.evidenceIds)).size).toBe(4);
    expect(ledger.reviewerAnomalies ?? []).toHaveLength(0);
  });

  it('reviewer 実行中に source が変わっても engine snapshot から quote を発行する', async () => {
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (hasSchemaProperty(options?.outputSchema, 'rawFindings')) {
        const finding = makeSourceQuoteFinding(persona, options?.outputSchema);
        const reportContent = String(finding.rawExcerpt);
        if (hasSchemaProperty(options?.outputSchema, 'reportContent')) {
          writeFileSync(join(cwd, 'src/reviewed.ts'), 'export const reviewed = false;\n');
        }
        return {
          persona,
          status: 'done',
          content: reportContent,
          structuredOutput: {
            ...(hasSchemaProperty(options?.outputSchema, 'reportContent')
              ? { reportContent }
              : {}),
            rawFindings: [finding],
          },
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

    const config = makeSingleReviewerConfig();
    await new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      findingAuthorityResolver: createTestFindingAuthorityResolver(config, cwd),
    }).runSingleIteration();

    const ledger = readFindingLedger(cwd, config.name);
    expect(ledger.findings).toHaveLength(1);
    expect(ledger.reviewerAnomalies ?? []).toHaveLength(0);
  });
});
