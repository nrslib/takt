import type { AgentResponse, CommandQualityGate, QualityGate, WorkflowStep } from '../../models/types.js';

interface CommandQualityGateFailureBase {
  gateName: string;
  type: 'command';
  command: string;
  cwd: string;
  projectRoot: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs?: number;
  outputLogPath?: string;
  outputLogError?: string;
}

export interface CommandOutputLimitFailureDetails {
  outputLimitExceeded: true;
  outputLimitBytes: number;
}

export type CommandQualityGateFailure = CommandQualityGateFailureBase & (
  | CommandOutputLimitFailureDetails
  | {
    outputLimitExceeded?: never;
    outputLimitBytes?: never;
  }
);

export type CommandQualityGateResult = {
  ok: true;
  stdout: string;
  stderr: string;
  evidence?: CommandQualityGateEvidence;
} | {
  ok: false;
  failure: CommandQualityGateFailure;
};

export interface RunCommandQualityGateOptions {
  gate: CommandQualityGate;
  projectRoot: string;
  childProcessEnv?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface CommandQualityGateEvidence {
  readonly name: string;
  readonly command: string;
  readonly exitCode: 0;
  readonly outputLogPath: string;
}

export type QualityGateRunResult = {
  ok: true;
  evidence?: readonly CommandQualityGateEvidence[];
} | {
  ok: false;
  response: AgentResponse;
};

export interface RunQualityGatesOptions {
  qualityGates: readonly QualityGate[] | undefined;
  runAt?: CommandQualityGate['runAt'];
  projectRoot: string;
  step: WorkflowStep;
  childProcessEnv?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  runWithoutInactivityTimeout?: (operation: () => Promise<QualityGateRunResult>) => Promise<QualityGateRunResult>;
  observabilityEnabled: boolean;
  runId?: string;
  workflowName?: string;
}
