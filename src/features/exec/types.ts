import type { ProviderType } from '../../infra/providers/index.js';

export type ExecEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ExecSessionConfig {
  provider?: ProviderType;
  model?: string;
  effort?: ExecEffort;
}

export interface ExecActorConfig {
  name: string;
  provider?: ProviderType;
  model?: string;
  effort?: ExecEffort;
  instruction: string;
  knowledge: string[];
  policy: string[];
}

export interface ExecReplanConfig {
  instruction: string;
  knowledge: string[];
  policy: string[];
}

export interface ExecLoopConfig {
  smallThreshold: number;
  largeThreshold: number;
  maxSteps: number;
}

export interface ExecConfig {
  session: ExecSessionConfig;
  replan: ExecReplanConfig;
  workers: ExecActorConfig[];
  reviews: ExecActorConfig[];
  loop: ExecLoopConfig;
}

export interface ResolvedExecSessionConfig extends ExecSessionConfig {
  provider: ProviderType;
}

export interface ResolvedExecActorConfig extends ExecActorConfig {
  provider: ProviderType;
}

export interface ResolvedExecConfig extends ExecConfig {
  session: ResolvedExecSessionConfig;
  workers: ResolvedExecActorConfig[];
  reviews: ResolvedExecActorConfig[];
}

export type ExecPresetScope = 'project' | 'global' | 'builtin';

export interface ExecPreset {
  name: string;
  description: string;
  source: ExecPresetScope;
  config: ExecConfig;
}
