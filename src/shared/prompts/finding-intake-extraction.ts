import type { Language } from '../../core/models/types.js';
import { loadTemplate } from './index.js';

function buildFindingIntakePrompt(
  report: string,
  language: Language,
  correction: boolean,
): string {
  return loadTemplate('parts/finding_intake_normalization', language, {
    report,
    correction,
  }).trimEnd();
}

export function buildFindingIntakeExtractionPrompt(
  report: string,
  language: Language,
): string {
  return buildFindingIntakePrompt(report, language, false);
}

export function buildFindingIntakeCorrectionPrompt(
  report: string,
  language: Language,
): string {
  return buildFindingIntakePrompt(report, language, true);
}
