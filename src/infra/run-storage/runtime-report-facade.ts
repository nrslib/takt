import {
  assertExactInput,
  type RuntimeBinding,
} from './runtime-binding.js';
import type { ExecutionHandle } from './runtime-handles.js';
import { createPublicReportStreamIdentity } from './report-stream-identity.js';
import { ReportRepository, type ReportRevision } from './reports.js';

class BoundReportCommands {
  readonly #binding: RuntimeBinding;
  readonly #repository = new ReportRepository();

  constructor(binding: RuntimeBinding) {
    this.#binding = binding;
  }

  publish(input: {
    readonly publicationKey: string;
    readonly streamName: string;
    readonly expectedRevision: number;
    readonly codecName: string;
    readonly content: string;
    readonly producer: ExecutionHandle;
  }): ReportRevision {
    assertExactInput(input, [
      'publicationKey',
      'streamName',
      'expectedRevision',
      'codecName',
      'content',
      'producer',
    ]);
    const stream = createPublicReportStreamIdentity(input.streamName);
    const producer = this.#binding.handles.resolveExecution(input.producer);
    return this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.append(context, {
        publicationKey: input.publicationKey,
        stream,
        expectedRevision: input.expectedRevision,
        codecName: input.codecName,
        content: input.content,
        producerScopeId: producer.scopeId,
        producerExecutionId: producer.executionId,
        runId: this.#binding.runId,
        ownerScopeId: this.#binding.scopeId,
        createdAt: now,
      }),
    );
  }

  history(streamName: string): ReportRevision[] {
    const stream = createPublicReportStreamIdentity(streamName);
    return this.#binding.executor.read((context) => (
      this.#repository.history(context, {
        runId: this.#binding.runId,
        ownerScopeId: this.#binding.scopeId,
        stream,
      })
    ));
  }
}

export type RuntimeReportCommands = BoundReportCommands;

export function createRuntimeReportCommands(
  binding: RuntimeBinding,
): RuntimeReportCommands {
  return new BoundReportCommands(binding);
}
