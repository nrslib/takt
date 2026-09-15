import type { ResolvedReportReferenceScope } from './report-reference.js';

export interface InjectedReport {
  readonly reference: string;
  readonly scope: ResolvedReportReferenceScope;
  readonly content: string;
}

export interface PreparedInstruction {
  readonly text: string;
  readonly injectedReports: readonly InjectedReport[];
}
