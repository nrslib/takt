import type { OpenCodeGuardOptions, OpenCodeGuardProfile } from '../../../core/models/index.js';
import {
  MAX_INSPECTED_BYTES_PER_SOURCE,
  MAX_TRACKED_SENSITIVE_VALUE_BYTES,
  MAX_TRACKED_SENSITIVE_VALUES,
} from '../../../shared/utils/sensitiveText.js';
import {
  OPENCODE_STREAM_EVENT_LIMIT,
  resolveOpenCodeStreamLimits,
  type OpenCodeStreamLimits,
} from '../OpenCodeStreamHandler.js';

export const OPENCODE_CALL_TIMEOUT_MIN_MS = 60_000;
export const OPENCODE_CALL_TIMEOUT_MAX_MS = 86_400_000;
export const OPENCODE_CALL_TIMEOUT_DEFAULT_MS = 3_600_000;
export const OPENCODE_EXACT_TOOL_REPEAT_LIMIT = 12;

const DEPRECATED_OPENCODE_GUARD_ENV_VARS = [
  'TAKT_OPENCODE_TOOL_ERROR_BUDGET',
  'TAKT_OPENCODE_TOOL_SIGNATURE_ABSOLUTE',
  'TAKT_OPENCODE_TOOL_SIGNATURE_REPEATS',
  'TAKT_OPENCODE_TOOL_SUCCESS_REPEATS',
  'TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS',
] as const;
const warnedDeprecatedGuardEnvVars = new Set<string>();

function warnDeprecatedGuardEnvironment(): void {
  for (const name of DEPRECATED_OPENCODE_GUARD_ENV_VARS) {
    if (process.env[name] === undefined || warnedDeprecatedGuardEnvVars.has(name)) continue;
    warnedDeprecatedGuardEnvVars.add(name);
    process.emitWarning(
      `${name} is deprecated and ignored by OpenCode guard v6; migrate to provider_options.opencode.guards`,
      { code: 'TAKT_DEPRECATED_OPENCODE_GUARD_ENV' },
    );
  }
}

export interface ResolvedOpenCodeToolGuardPolicy {
  recentWindow: number;
  recentWindowErrorRatePercent: number;
  consecutiveErrors: number;
  editConflictRepeats: number;
  editCorrectionLimit: number;
}

export interface ResolvedOpenCodeGuardPolicy {
  profile: OpenCodeGuardProfile;
  callTimeoutMs: number;
  streamIdleTimeoutMs: number;
  messageCycleBudget: number;
  exactToolRepeatLimit: number;
  streamLimits: OpenCodeStreamLimits;
  streamEventLimit: number;
  sensitiveCandidateLimit: number;
  sensitiveCandidateByteLimit: number;
  sensitiveSourceScanByteLimit: number;
  toolGuard: ResolvedOpenCodeToolGuardPolicy;
}

function resolvePositiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveCallTimeoutMs(configured: number | undefined): number {
  const raw = process.env.TAKT_OPENCODE_CALL_TIMEOUT_MS;
  const candidate = raw === undefined ? configured ?? OPENCODE_CALL_TIMEOUT_DEFAULT_MS : Number(raw);
  if (
    !Number.isInteger(candidate)
    || candidate < OPENCODE_CALL_TIMEOUT_MIN_MS
    || candidate > OPENCODE_CALL_TIMEOUT_MAX_MS
  ) {
    throw new Error(
      `OpenCode call timeout must be an integer between ${OPENCODE_CALL_TIMEOUT_MIN_MS} and ${OPENCODE_CALL_TIMEOUT_MAX_MS} ms`,
    );
  }
  return candidate;
}

function assertPositiveLimit(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`OpenCode ${name} must be a positive integer`);
  }
}

export function resolveOpenCodeGuardPolicy(
  guards: OpenCodeGuardOptions | undefined,
  profile: OpenCodeGuardProfile,
): ResolvedOpenCodeGuardPolicy {
  warnDeprecatedGuardEnvironment();
  assertPositiveLimit('event limit', guards?.eventLimit);
  assertPositiveLimit('text byte limit', guards?.textByteLimit);
  assertPositiveLimit('reasoning byte limit', guards?.reasoningByteLimit);
  return {
    profile,
    callTimeoutMs: resolveCallTimeoutMs(guards?.callTimeoutMs),
    streamIdleTimeoutMs: resolvePositiveEnvInt('TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS', 10 * 60 * 1000),
    messageCycleBudget: resolvePositiveEnvInt('TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET', 120),
    exactToolRepeatLimit: OPENCODE_EXACT_TOOL_REPEAT_LIMIT,
    streamLimits: resolveOpenCodeStreamLimits(guards),
    streamEventLimit: resolvePositiveEnvInt(
      'TAKT_OPENCODE_STREAM_EVENT_LIMIT',
      guards?.eventLimit ?? OPENCODE_STREAM_EVENT_LIMIT,
    ),
    sensitiveCandidateLimit: MAX_TRACKED_SENSITIVE_VALUES,
    sensitiveCandidateByteLimit: MAX_TRACKED_SENSITIVE_VALUE_BYTES,
    sensitiveSourceScanByteLimit: MAX_INSPECTED_BYTES_PER_SOURCE,
    toolGuard: {
      recentWindow: resolvePositiveEnvInt('TAKT_OPENCODE_TOOL_ERROR_WINDOW', 20),
      recentWindowErrorRatePercent: resolvePositiveEnvInt('TAKT_OPENCODE_TOOL_ERROR_WINDOW_RATE', 90),
      consecutiveErrors: resolvePositiveEnvInt('TAKT_OPENCODE_TOOL_ERROR_CONSECUTIVE', 10),
      editConflictRepeats: resolvePositiveEnvInt('TAKT_OPENCODE_EDIT_CONFLICT_REPEATS', 3),
      editCorrectionLimit: resolvePositiveEnvInt('TAKT_OPENCODE_EDIT_CORRECTION_LIMIT', 2),
    },
  };
}
