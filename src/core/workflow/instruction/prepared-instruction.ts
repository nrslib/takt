import type { ResolvedReportReferenceScope } from './report-reference.js';
import type { WorkflowStep } from '../../models/types.js';
import type { ReportExecutionMetadata } from '../report-execution-store.js';

export interface ReportReferenceConsumer {
  readonly workflowRef: string;
  readonly callPath: readonly { readonly workflowRef: string; readonly step: string }[];
  readonly stepPath: readonly string[];
}

export interface ReportReferenceResolution {
  readonly reference: string;
  readonly scope: ResolvedReportReferenceScope | 'declared-producer';
  readonly producer?: string;
}

export interface ReportReferenceObserver {
  resolved(step: WorkflowStep, currentStep: string, reports: readonly ReportReferenceResolution[]): void;
}

export interface ReportReferencesResolved {
  readonly consumer: ReportReferenceConsumer;
  readonly reports: readonly ReportReferenceResolution[];
}

export interface InjectedReport {
  readonly execution?: ReportExecutionMetadata;
  readonly origin?: ReportExecutionMetadata;
  readonly path?: string;
  readonly history?: string;
  readonly kind?: 'history';
  readonly reference: string;
  readonly scope: ResolvedReportReferenceScope | 'declared-producer';
  readonly content: string;
  readonly producer?: string;
}

export const CURRENT_REPORT_BODY_LIMIT = 8_000;

export function renderCurrentReport(report: InjectedReport): string {
  if (report.content.length <= CURRENT_REPORT_BODY_LIMIT) return report.content;
  if (report.path === undefined) throw new Error(`A fixed version is required to truncate report "${report.reference}"`);
  return `${report.content.slice(0, CURRENT_REPORT_BODY_LIMIT)}\n\n[Report truncated; full version: \`${report.path}\`]`;
}

export interface DeclaredReportInputs {
  readonly declaredNames: readonly string[];
  readonly reports: readonly InjectedReport[];
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
