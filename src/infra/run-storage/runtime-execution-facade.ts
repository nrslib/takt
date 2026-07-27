import { ExecutionRepository } from './execution.js';
import type { ExecutionRuntimeState } from './execution-state-reader.js';
import {
  assertExactInput,
  type RuntimeBinding,
} from './runtime-binding.js';
import type {
  ExecutionHandle,
  PersonaSessionHandle,
  PhaseExecutionHandle,
  RunSessionHandle,
  StartedExecution,
} from './runtime-handles.js';

class BoundExecutionCommands {
  readonly #binding: RuntimeBinding;
  readonly #repository = new ExecutionRepository();

  constructor(binding: RuntimeBinding) {
    this.#binding = binding;
  }

  startStep(input: {
    readonly stepKey: string;
    readonly expectedScopeRevision: number;
    readonly session?: RunSessionHandle;
    readonly personaSession?: PersonaSessionHandle;
  }): StartedExecution {
    assertExactInput(input, [
      'stepKey',
      'expectedScopeRevision',
      'session',
      'personaSession',
    ]);
    const session = input.session === undefined
      ? undefined
      : this.#binding.handles.resolveSession(input.session);
    const personaSession = input.personaSession === undefined
      ? undefined
      : this.#binding.handles.resolvePersonaSession(input.personaSession);
    this.assertOptionalScope(session?.scopeId, 'Run session');
    this.assertOptionalScope(personaSession?.scopeId, 'Persona session');
    const started = this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.startStep(context, {
        stepId: input.stepKey,
        runSessionId: session?.sessionId,
        personaSessionId: personaSession?.sessionId,
        expectedScopeRevision: input.expectedScopeRevision,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        startedAt: now,
      }),
    );
    return {
      ...started,
      handle: this.#binding.handles.issueExecution(
        this.#binding.scopeId,
        started.executionId,
      ),
    };
  }

  finishStep(input: {
    readonly execution: ExecutionHandle;
    readonly status: 'completed' | 'failed' | 'cancelled';
  }): void {
    assertExactInput(input, ['execution', 'status']);
    const execution = this.resolveExecution(input.execution);
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.finishStep(context, {
        executionId: execution.executionId,
        status: input.status,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        terminalAt: now,
      }),
    );
  }

  startPhase(input: {
    readonly execution: ExecutionHandle;
    readonly phase: string;
    readonly ordinal: number;
  }): PhaseExecutionHandle {
    assertExactInput(input, ['execution', 'phase', 'ordinal']);
    const execution = this.resolveExecution(input.execution);
    const phaseExecutionId = this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.startPhase(context, {
        stepExecutionId: execution.executionId,
        phase: input.phase,
        ordinal: input.ordinal,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        startedAt: now,
      }),
    );
    return this.#binding.handles.issuePhase(
      this.#binding.scopeId,
      phaseExecutionId,
    );
  }

  finishPhase(input: {
    readonly phaseExecution: PhaseExecutionHandle;
    readonly status: 'completed' | 'failed' | 'cancelled';
  }): void {
    assertExactInput(input, ['phaseExecution', 'status']);
    const phase = this.resolvePhase(input.phaseExecution);
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.finishPhase(context, {
        phaseExecutionId: phase.phaseExecutionId,
        status: input.status,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        terminalAt: now,
      }),
    );
  }

  recordJudgeStage(input: {
    readonly phaseExecution: PhaseExecutionHandle;
    readonly stage: string;
    readonly codecName: string;
    readonly result: string;
  }): void {
    assertExactInput(input, ['phaseExecution', 'stage', 'codecName', 'result']);
    const phase = this.resolvePhase(input.phaseExecution);
    this.#binding.executor.write(
      this.#binding.owner,
      (context) => this.#repository.recordJudgeStage(context, {
        phaseExecutionId: phase.phaseExecutionId,
        stage: input.stage,
        codecName: input.codecName,
        result: input.result,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
      }),
    );
  }

  recordStepOutput(input: {
    readonly execution: ExecutionHandle;
    readonly outputName: string;
    readonly codecName: string;
    readonly content: string;
  }): void {
    assertExactInput(input, ['execution', 'outputName', 'codecName', 'content']);
    const execution = this.resolveExecution(input.execution);
    this.#binding.executor.write(
      this.#binding.owner,
      (context) => this.#repository.recordStepOutput(context, {
        executionId: execution.executionId,
        outputName: input.outputName,
        codecName: input.codecName,
        content: input.content,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
      }),
    );
  }

  recordStructuredOutput(input: {
    readonly execution: ExecutionHandle;
    readonly codecName: string;
    readonly output: string;
  }): void {
    assertExactInput(input, ['execution', 'codecName', 'output']);
    const execution = this.resolveExecution(input.execution);
    this.#binding.executor.write(
      this.#binding.owner,
      (context) => this.#repository.recordStructuredOutput(context, {
        executionId: execution.executionId,
        codecName: input.codecName,
        output: input.output,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
      }),
    );
  }

  loadRuntime(): ExecutionRuntimeState {
    return this.#binding.executor.read((context) => (
      this.#repository.loadRuntime(
        context,
        this.#binding.runId,
        this.#binding.scopeId,
      )
    ));
  }

  private resolveExecution(handle: ExecutionHandle): {
    readonly scopeId: string;
    readonly executionId: string;
  } {
    const execution = this.#binding.handles.resolveExecution(handle);
    this.assertScope(execution.scopeId, 'Execution');
    return execution;
  }

  private resolvePhase(handle: PhaseExecutionHandle): {
    readonly scopeId: string;
    readonly phaseExecutionId: string;
  } {
    const phase = this.#binding.handles.resolvePhase(handle);
    this.assertScope(phase.scopeId, 'Execution');
    return phase;
  }

  private assertOptionalScope(scopeId: string | undefined, label: string): void {
    if (scopeId !== undefined) {
      this.assertScope(scopeId, label);
    }
  }

  private assertScope(scopeId: string, label: string): void {
    if (scopeId !== this.#binding.scopeId) {
      throw new Error(`${label} handle cross-scope reference rejected`);
    }
  }
}

export type RuntimeExecutionCommands = BoundExecutionCommands;

export function createRuntimeExecutionCommands(
  binding: RuntimeBinding,
): RuntimeExecutionCommands {
  return new BoundExecutionCommands(binding);
}
