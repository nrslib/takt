import type { Language } from '../../core/models/types.js';
import { loadTemplate } from './index.js';

function buildFindingIntakePrompt(
  report: string,
  language: Language,
  correction: boolean,
  extractionFidelityCorrection: boolean,
): string {
  return loadTemplate('parts/finding_intake_normalization', language, {
    report,
    correction,
    extractionFidelityCorrection,
  }).trimEnd();
}

export function buildFindingIntakeExtractionPrompt(
  report: string,
  language: Language,
): string {
  return buildFindingIntakePrompt(report, language, false, false);
}

export function buildFindingIntakeCorrectionPrompt(
  report: string,
  language: Language,
  extractionFidelityCorrection = false,
): string {
  return buildFindingIntakePrompt(report, language, true, extractionFidelityCorrection);
}

export function buildFindingEvidenceSearchPrompt(
  report: string,
  language: Language,
): string {
  return loadTemplate('parts/finding_evidence_search', language, { report }).trimEnd();
}
