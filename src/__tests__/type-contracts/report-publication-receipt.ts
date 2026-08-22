import type { ReportPublicationReceipt } from '../../core/workflow/report-publication.js';

declare const receipt: ReportPublicationReceipt;

void receipt.publicationId;
void receipt.streamId;
void receipt.revision;
void receipt.contentSha256;

// @ts-expect-error Publication receipts must not expose a filesystem path.
void receipt.targetPath;
