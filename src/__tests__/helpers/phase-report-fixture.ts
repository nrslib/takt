import type { ReportPhaseRunnerContext } from '../../core/workflow/phase-runner.js';
import { writeReportFile } from '../../core/workflow/report-writer.js';

/** Keep fake Phase 2 producers on the same accepted-publication boundary as production. */
export function writePhaseReportFixture(
  context: Pick<ReportPhaseRunnerContext, 'reportDir' | 'reportContentSanitizer' | 'onReportPersisted'>,
  name: string,
  content: string,
): void {
  writeReportFile(context.reportDir, name, content, context.reportContentSanitizer,
    (persisted) => context.onReportPersisted?.(name, persisted));
}
