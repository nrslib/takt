import type { RunReadContext } from '../../infra/run-storage/context.js';
import type { PublicReportStreamIdentity } from '../../infra/run-storage/report-stream-identity.js';
import { ReportRepository } from '../../infra/run-storage/reports.js';

declare const context: RunReadContext;
declare const stream: PublicReportStreamIdentity;

const repository = new ReportRepository();

repository.history(context, {
  runId: 'run-1',
  ownerScopeId: 'root',
  stream,
});
repository.revision(context, {
  runId: 'run-1',
  ownerScopeId: 'root',
  stream,
  revision: 1,
});

repository.history(context, {
  runId: 'run-1',
  ownerScopeId: 'root',
  // @ts-expect-error Repository read boundaries require the branded stream identity.
  stream: 'report.json',
});

repository.revision(context, {
  runId: 'run-1',
  ownerScopeId: 'root',
  // @ts-expect-error Receipt streamId strings cannot replace the branded identity.
  streamId: 'forged-stream-id',
  revision: 1,
});
