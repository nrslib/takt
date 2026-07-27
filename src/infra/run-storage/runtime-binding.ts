import type { RunReadContext, RunWriteContext } from './context.js';
import type { LeaseOwner } from './lease.js';
import type {
  ExecutionHandle,
  OperationHandle,
  PersonaSessionHandle,
  PhaseExecutionHandle,
  RecoveryHandle,
  RunSessionHandle,
  ScopeHandle,
} from './runtime-handles.js';
import type { TrustedFindingResumeSource } from './finding-resume-source.js';

export interface RunStorageExecutor {
  read<Result>(command: (context: RunReadContext) => Result): Result;
  write<Result>(
    owner: LeaseOwner,
    command: (context: RunWriteContext, now: number) => Result,
  ): Result;
  operation<Result>(
    owner: LeaseOwner,
    command: (context: RunWriteContext, now: number) => Result,
  ): Result;
}

export interface RuntimeHandleAuthority {
  issueScope(scopeId: string): ScopeHandle;
  issueExecution(scopeId: string, executionId: string): ExecutionHandle;
  resolveExecution(handle: ExecutionHandle): {
    readonly scopeId: string;
    readonly executionId: string;
  };
  issuePhase(scopeId: string, phaseExecutionId: string): PhaseExecutionHandle;
  resolvePhase(handle: PhaseExecutionHandle): {
    readonly scopeId: string;
    readonly phaseExecutionId: string;
  };
  issueOperation(scopeId: string, operationId: string): OperationHandle;
  resolveOperation(handle: OperationHandle): {
    readonly scopeId: string;
    readonly operationId: string;
  };
  issueSession(scopeId: string, sessionId: string): RunSessionHandle;
  resolveSession(handle: RunSessionHandle): {
    readonly scopeId: string;
    readonly sessionId: string;
  };
  issuePersonaSession(
    scopeId: string,
    sessionId: string,
  ): PersonaSessionHandle;
  resolvePersonaSession(handle: PersonaSessionHandle): {
    readonly scopeId: string;
    readonly sessionId: string;
  };
  issueRecovery(scopeId: string, recoveryId: string): RecoveryHandle;
  resolveRecovery(handle: RecoveryHandle): {
    readonly scopeId: string;
    readonly recoveryId: string;
  };
}

export interface RuntimeBinding {
  readonly executor: RunStorageExecutor;
  readonly handles: RuntimeHandleAuthority;
  readonly owner: LeaseOwner;
  readonly runId: string;
  readonly scopeId: string;
  readonly trustedFindingResumeSource?: TrustedFindingResumeSource;
}

export function assertExactInput(
  input: object,
  allowed: readonly string[],
): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!keys.has(key)) {
      throw new Error(`Unknown run storage command field "${key}"`);
    }
  }
}
