import type { ResolvedReportReferenceScope } from './report-reference.js';
import type { WorkflowStep } from '../../models/types.js';

export interface ReportReferenceConsumer {
  readonly workflowRef: string;
  readonly callPath: readonly { readonly workflowRef: string; readonly step: string }[];
  readonly stepPath: readonly string[];
}

export interface ReportReferenceResolution {
  readonly reference: string;
  readonly scope: ResolvedReportReferenceScope;
}

export interface ReportReferenceObserver {
  resolved(step: WorkflowStep, currentStep: string, reports: readonly ReportReferenceResolution[]): void;
}

export interface ReportReferencesResolved {
  readonly consumer: ReportReferenceConsumer;
  readonly reports: readonly ReportReferenceResolution[];
}

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
