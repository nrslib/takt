
export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpSseServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpSseServerConfig | McpHttpServerConfig;

export interface ProviderGuardOptions {
  /** プロバイダイベントが届かない時間の上限 (ms)。既定 60 分。 */
  callTimeoutMs?: number;
}

export interface CodexProviderOptions {
  baseUrl?: string;
  networkAccess?: boolean;
  permissionControl?: CodexPermissionControl;
  reasoningEffort?: CodexReasoningEffort;
  fastMode?: boolean;
  guards?: ProviderGuardOptions;
  skills?: {
    repo?: boolean;
    user?: boolean;
  };
}

export type CodexPermissionControl = 'takt' | 'codex';

export const OPENCODE_GUARD_PROFILES = ['standard', 'minimal'] as const;
export type OpenCodeGuardProfile = (typeof OPENCODE_GUARD_PROFILES)[number];

/**
 * OpenCode 実行ガード設定。
 * profile が切るのはヒューリスティック検出（連続エラー・burst・cycle budget・
 * 連続完全一致反復）のみ。無応答期限・有界資源（容量・イベント数・追跡ID数）・
 * 機密リダクションの fail-closed・厳密検出（edit conflict / unavailable / invalid
 * + correction）は minimal でも常時有効。idle watchdog は認証済み transport
 * の拡張として明示的に追加する場合だけ利用する。
 */
export interface OpenCodeGuardOptions {
  /** standard（既定）= 全ガード有効。minimal = ヒューリスティック検出のみ無効。 */
  profile?: OpenCodeGuardProfile;
  /** 解決済みモデル文字列に対する先勝ちの `*` ワイルドカードプロファイル。 */
  modelProfiles?: Record<string, OpenCodeGuardProfile>;
  /** プロバイダイベントが届かない時間の上限 (ms)。60,000〜86,400,000 の整数。0 不可。既定 3,600,000。 */
  callTimeoutMs?: number;
  /** 構造イベント数上限。既定 500,000。 */
  eventLimit?: number;
  /** 可視テキスト累計バイト上限。既定 1MiB。 */
  textByteLimit?: number;
  /** reasoning 累計バイト上限。既定 4MiB。 */
  reasoningByteLimit?: number;
}

export interface OpenCodeProviderOptions {
  networkAccess?: boolean;
  variant?: string;
  allowedTools?: string[];
  guards?: OpenCodeGuardOptions;
}

export const RUNTIME_PREPARE_PRESETS = ['gradle', 'node'] as const;
export type RuntimePreparePreset = (typeof RUNTIME_PREPARE_PRESETS)[number];
export type CodexReasoningEffort = string;
export type ClaudeEffort = string;
export type CopilotEffort = string;
const RUNTIME_PREPARE_PRESET_SET: ReadonlySet<string> = new Set(RUNTIME_PREPARE_PRESETS);

export function isRuntimePreparePreset(entry: string): entry is RuntimePreparePreset {
  return RUNTIME_PREPARE_PRESET_SET.has(entry);
}

export type RuntimePrepareEntry = RuntimePreparePreset | string;

export interface WorkflowRuntimeConfig {
  prepare?: RuntimePrepareEntry[];
}

export interface ClaudeSandboxSettings {
  allowUnsandboxedCommands?: boolean;
  excludedCommands?: string[];
}

export interface ClaudeSkillOptions {
  enabled?: boolean;
}

export interface ClaudeProviderOptions {
  baseUrl?: string;
  allowedTools?: string[];
  effort?: ClaudeEffort;
  skills?: ClaudeSkillOptions;
  sandbox?: ClaudeSandboxSettings;
  guards?: ProviderGuardOptions;
}

export interface ClaudeTerminalProviderOptions {
  backend?: 'tmux';
  guards?: ProviderGuardOptions;
  /** 旧設定。guards.callTimeoutMs が未指定の場合だけ無応答上限として使う。 */
  timeoutMs?: number;
  keepSession?: boolean;
  transcriptPollIntervalMs?: number;
}

export interface CopilotProviderOptions {
  effort?: CopilotEffort;
  guards?: ProviderGuardOptions;
}

export interface KiroProviderOptions {
  agent?: string;
  guards?: ProviderGuardOptions;
}

export interface CursorProviderOptions {
  guards?: ProviderGuardOptions;
}

/** Configuration for the DeepSeek Harness Python SDK bridge. */
export interface DeepSeekHarnessProviderOptions {
  pythonPath?: string;
  baseUrl?: string;
  sessionRoot?: string;
  cordis?: string;
  maxTokens?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  runtimeMode?: 'exe' | 'node';
}

/** Pi SDK resource-loading options. Extension sources are resolved temporarily. */
export interface PiProviderOptions {
  guards?: ProviderGuardOptions;
  extensions?: string[];
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
}

export interface StepProviderOptions {
  codex?: CodexProviderOptions;
  opencode?: OpenCodeProviderOptions;
  claude?: ClaudeProviderOptions;
  claudeTerminal?: ClaudeTerminalProviderOptions;
  cursor?: CursorProviderOptions;
  copilot?: CopilotProviderOptions;
  kiro?: KiroProviderOptions;
  pi?: PiProviderOptions;
  deepseekHarness?: DeepSeekHarnessProviderOptions;
}

export type WorkflowStepKind = 'agent' | 'system' | 'workflow_call';
