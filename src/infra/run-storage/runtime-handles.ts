declare const RUN_STORAGE_HANDLE: unique symbol;

interface OpaqueRunStorageHandle<Kind extends string> {
  readonly [RUN_STORAGE_HANDLE]: Kind;
}

export type LeaseHandle = OpaqueRunStorageHandle<'lease'>;
export type ScopeHandle = OpaqueRunStorageHandle<'scope'>;
export type ExecutionHandle = OpaqueRunStorageHandle<'execution'>;
export type PhaseExecutionHandle = OpaqueRunStorageHandle<'phase-execution'>;
export type OperationHandle = OpaqueRunStorageHandle<'operation'>;
export type RunSessionHandle = OpaqueRunStorageHandle<'run-session'>;
export type PersonaSessionHandle = OpaqueRunStorageHandle<'persona-session'>;
export type RecoveryHandle = OpaqueRunStorageHandle<'recovery'>;

export interface StartedExecution {
  readonly handle: ExecutionHandle;
  readonly iteration: number;
  readonly scopeRevision: number;
  readonly startedAt: number;
}

export interface PreparedOperation {
  readonly handle: OperationHandle;
  readonly state: string;
}

export interface RuntimeOperationSnapshot {
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly state: string;
  readonly request: {
    readonly codecName: string;
    readonly encoded: string;
    readonly digest: string;
  };
  readonly response?: {
    readonly codecName: string;
    readonly encoded: string;
    readonly digest: string;
  };
  readonly error?: {
    readonly codecName: string;
    readonly encoded: string;
    readonly digest: string;
  };
}
