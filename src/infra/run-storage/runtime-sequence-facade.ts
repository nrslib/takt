import {
  assertExactInput,
  type RuntimeBinding,
} from './runtime-binding.js';
import { RuntimeSequenceRepository } from './runtime-sequences.js';

type RuntimeEvent = ReturnType<RuntimeSequenceRepository['listEvents']>[number];

class BoundSequenceCommands {
  readonly #binding: RuntimeBinding;
  readonly #repository = new RuntimeSequenceRepository();

  constructor(binding: RuntimeBinding) {
    this.#binding = binding;
  }

  appendEvent(input: {
    readonly expectedSequence: number;
    readonly eventType: string;
    readonly codecName?: string;
    readonly payload?: string;
  }): number {
    assertExactInput(input, [
      'expectedSequence',
      'eventType',
      'codecName',
      'payload',
    ]);
    return this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.appendEvent(context, {
        ...input,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        occurredAt: now,
      }),
    );
  }

  recordResponseSnapshot(input: {
    readonly expectedSequence: number;
    readonly codecName: string;
    readonly response: string;
  }): number {
    assertExactInput(input, ['expectedSequence', 'codecName', 'response']);
    return this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.recordResponseSnapshot(context, {
        ...input,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        createdAt: now,
      }),
    );
  }

  listEvents(): RuntimeEvent[] {
    return this.#binding.executor.read((context) => (
      this.#repository.listEvents(
        context,
        this.#binding.runId,
        this.#binding.scopeId,
      )
    ));
  }
}

export type RuntimeSequenceCommands = BoundSequenceCommands;

export function createRuntimeSequenceCommands(
  binding: RuntimeBinding,
): RuntimeSequenceCommands {
  return new BoundSequenceCommands(binding);
}
