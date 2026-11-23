import type { ContextWindowSetting } from '../../core/models/workflow-provider-options.js';

export interface ContextWindowLimits {
  /** Native configured/catalog context size. */
  readonly default: number;
  /** Confirmed expandable maximum, if known. */
  readonly maximum?: number;
  /** Effective capacity percentage; omitted means 100%. */
  readonly effectivePercent?: number;
}

export interface ContextWindowStage {
  readonly name: 'default' | 'high' | 'max';
  readonly size: number;
  readonly effectiveSize: number;
}

export interface ContextWindowSelection {
  readonly override?: number;
  readonly stages: readonly ContextWindowStage[];
  readonly stageIndex: number;
  readonly requiredTokens?: number;
  readonly fixedTokens?: number;
  readonly reason: 'manual' | 'fits' | 'maximum' | 'unknown';
}

function stage(name: ContextWindowStage['name'], size: number, percent: number): ContextWindowStage {
  return { name, size, effectiveSize: Math.floor(size * percent / 100) };
}

export function estimateContextTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x80) ascii++;
    else if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xff00 && code <= 0xffef)) cjk++;
    else other++;
  }
  return Math.ceil(ascii / 4 + cjk * 0.75 + other / 2);
}

export function estimateRequiredContextTokens(texts: readonly string[]): { fixedTokens: number; requiredTokens: number } {
  const fixedTokens = texts.reduce((sum, text) => sum + estimateContextTokens(text), 0);
  return { fixedTokens, requiredTokens: Math.ceil((fixedTokens * 2 + 150_000) * 1.2) };
}

export function selectContextWindow(
  setting: ContextWindowSetting,
  limits: ContextWindowLimits | undefined,
  texts: readonly string[],
): ContextWindowSelection {
  if (setting !== 'auto') {
    return { override: setting, stages: [], stageIndex: 0, reason: 'manual' };
  }
  if (limits === undefined || !Number.isSafeInteger(limits.default) || limits.default <= 0) {
    return { stages: [], stageIndex: 0, reason: 'unknown' };
  }
  const percent = limits.effectivePercent ?? 100;
  const stages: ContextWindowStage[] = [stage('default', limits.default, percent)];
  const maximum = limits.maximum;
  if (maximum !== undefined && Number.isSafeInteger(maximum) && maximum > limits.default) {
    const high = Math.min(500_000, maximum);
    if (high > limits.default) stages.push(stage('high', high, percent));
    if (maximum > stages[stages.length - 1]!.size) stages.push(stage('max', maximum, percent));
  }
  const { fixedTokens, requiredTokens } = estimateRequiredContextTokens(texts);
  const fittingIndex = stages.findIndex((candidate) => requiredTokens <= candidate.effectiveSize);
  const stageIndex = fittingIndex === -1 ? stages.length - 1 : fittingIndex;
  return {
    ...(stageIndex === 0 ? {} : { override: stages[stageIndex]!.size }),
    stages,
    stageIndex,
    fixedTokens,
    requiredTokens,
    reason: fittingIndex === -1 ? 'maximum' : 'fits',
  };
}

export function promoteContextWindow(selection: ContextWindowSelection): ContextWindowSelection {
  if (selection.reason === 'manual' || selection.reason === 'unknown') return selection;
  const nextIndex = selection.stageIndex + 1;
  const next = selection.stages[nextIndex];
  if (next === undefined) return selection;
  return { ...selection, stageIndex: nextIndex, override: next.size };
}
