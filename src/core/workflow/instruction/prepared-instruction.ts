import type { ResolvedReportReferenceScope } from './report-reference.js';

export interface InjectedReport {
  readonly reference: string;
  readonly scope: ResolvedReportReferenceScope;
  readonly content: string;
}

export interface PreparedInstruction {
  readonly text: string;
  readonly injectedReports: readonly InjectedReport[];
  readonly reportInputs?: Phase1ReportInputs;
}

/** Inputs actually supplied to Phase 1, independent of provider session history. */
export interface Phase1ReportInputs {
  readonly userInputs: readonly string[];
  readonly previousResponse?: string;
}
