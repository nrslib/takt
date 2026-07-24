import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type {
  FindingManagerReportPublication,
  FindingManagerValidationReport,
} from '../../core/workflow/findings/types.js';
import type {
  FindingArtifactWriter,
} from '../../core/workflow/findings/store.js';

type PublicationMethods = Pick<
  FindingArtifactWriter,
  | 'planManagerValidationPublication'
  | 'bindManagerValidationPublication'
  | 'publishManagerValidationPublication'
  | 'assertManagerValidationPublication'
>;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function reportContent(report: FindingManagerValidationReport): string {
  return JSON.stringify(report, null, 2);
}

function publicationId(
  roundMarker: string,
  report: FindingManagerValidationReport,
  contentSha256: string,
): string {
  return sha256([roundMarker, report.runId, report.stepName, contentSha256].join('\0'));
}

export function createFindingManagerPublicationDouble(
  saveReport: (report: FindingManagerValidationReport) => string,
): PublicationMethods {
  const domainId = sha256('finding-manager-publication-test-domain');
  const receipts = new Map<string, {
    publicationId: string;
    targetPath: string;
    targetDevice: string;
    targetInode: string;
    contentSha256: string;
  }>();
  return {
    planManagerValidationPublication: (roundMarker, report) => {
      const contentSha256 = sha256(reportContent(report));
      return {
        publicationId: publicationId(roundMarker, report, contentSha256),
        domainId,
        originRunId: report.runId,
        destinationRunId: report.runId,
        fileName: `findings-manager-validation.${report.stepName}.json`,
        contentSha256,
        report,
      };
    },
    bindManagerValidationPublication: (roundMarker, publication) => {
      const contentSha256 = sha256(reportContent(publication.report));
      if (publication.domainId !== domainId
        || publication.report.runId !== publication.originRunId
        || publication.destinationRunId !== publication.originRunId
        || publication.fileName !== `findings-manager-validation.${publication.report.stepName}.json`
        || publication.contentSha256 !== contentSha256
        || publication.publicationId !== publicationId(
          roundMarker,
          publication.report,
          contentSha256,
        )) {
        throw new Error(`Invalid test manager publication "${publication.publicationId}"`);
      }
      return publication;
    },
    publishManagerValidationPublication: (publication) => {
      if (publication.domainId !== domainId
        || publication.destinationRunId !== publication.report.runId) {
        throw new Error(`Unbound test manager publication "${publication.publicationId}"`);
      }
      const targetPath = saveReport(publication.report);
      if (basename(targetPath) !== publication.fileName) {
        throw new Error(
          `Test manager publication target "${targetPath}" does not match "${publication.fileName}"`,
        );
      }
      const receipt = {
        publicationId: publication.publicationId,
        targetPath,
        targetDevice: 'test-device',
        targetInode: publication.publicationId,
        contentSha256: publication.contentSha256,
      };
      receipts.set(publication.publicationId, receipt);
      return receipt;
    },
    assertManagerValidationPublication: (
      publication: FindingManagerReportPublication,
      receipt,
    ) => {
      const published = receipts.get(publication.publicationId);
      if (published === undefined
        || receipt.publicationId !== published.publicationId
        || receipt.targetPath !== published.targetPath
        || receipt.targetDevice !== published.targetDevice
        || receipt.targetInode !== published.targetInode
        || receipt.contentSha256 !== published.contentSha256
        || receipt.contentSha256 !== publication.contentSha256) {
        throw new Error(`Invalid test manager publication receipt "${receipt.publicationId}"`);
      }
    },
  };
}
