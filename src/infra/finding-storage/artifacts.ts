import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  FindingManagerReportPublication,
  FindingManagerValidationReport,
  RawFinding,
} from '../../core/workflow/findings/types.js';
import { parseRawFindings } from '../../core/workflow/findings/schemas.js';
import {
  computeFindingManagerReportPublicationId,
  findingManagerValidationReportFileName,
  serializeFindingManagerValidationReport,
} from '../../core/workflow/findings/manager-report-content.js';
import {
  finalizeReportPublication,
  publishReportFile,
  reportPublicationStreamId,
  writeReportFile,
} from '../../core/workflow/report-writer.js';
import type { ReportPublicationReceipt } from '../../core/workflow/report-publication.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizeFileSegment(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (sanitized.length === 0) {
    throw new Error(`Invalid Finding artifact segment: ${value}`);
  }
  return sanitized;
}

export function managerReportContent(report: FindingManagerValidationReport): string {
  return serializeFindingManagerValidationReport(report);
}

export function sameManagerPublication(
  left: FindingManagerReportPublication,
  right: FindingManagerReportPublication,
): boolean {
  return left.publicationId === right.publicationId
    && left.domainId === right.domainId
    && left.originRunId === right.originRunId
    && left.destinationRunId === right.destinationRunId
    && left.fileName === right.fileName
    && left.contentSha256 === right.contentSha256
    && managerReportContent(left.report) === managerReportContent(right.report);
}

export function validateManagerPublication(
  roundMarker: string,
  publication: FindingManagerReportPublication,
): void {
  const content = managerReportContent(publication.report);
  const expectedFileName = findingManagerValidationReportFileName(publication.report);
  const expectedContentSha256 = sha256(content);
  const expectedPublicationId = computeFindingManagerReportPublicationId({
    roundMarker,
    originRunId: publication.originRunId,
    fileName: publication.fileName,
    contentSha256: publication.contentSha256,
  });
  if (publication.report.runId !== publication.originRunId
    || publication.fileName !== expectedFileName
    || publication.contentSha256 !== expectedContentSha256
    || publication.publicationId !== expectedPublicationId) {
    throw new Error(
      `Finding manager publication "${publication.publicationId}" failed integrity validation`,
    );
  }
}

export class FindingArtifactStore {
  readonly #reportDir: string;
  readonly #runId: string;
  readonly #domainId: string;

  constructor(input: {
    readonly reportDir: string;
    readonly runId: string;
    readonly databaseInstanceId: string;
    readonly authorityKey: string;
  }) {
    this.#reportDir = resolve(input.reportDir);
    this.#runId = input.runId;
    this.#domainId = sha256([
      'finding-authority',
      input.databaseInstanceId,
      input.authorityKey,
    ].join('\0'));
  }

  get domainId(): string {
    return this.#domainId;
  }

  saveLedgerSnapshot(ledgerJson: string): void {
    writeReportFile(this.#reportDir, 'findings-ledger.json', ledgerJson);
  }

  saveRawFindings(runId: string, stepName: string, rawFindings: RawFinding[]): void {
    if (runId !== this.#runId) {
      throw new Error(`Raw Finding run "${runId}" does not match the store-bound run identity`);
    }
    const parsed = parseRawFindings(rawFindings);
    writeReportFile(
      this.#reportDir,
      `raw-findings.${sanitizeFileSegment(stepName)}.json`,
      JSON.stringify(parsed, null, 2),
    );
  }

  saveManagerValidationReport(report: FindingManagerValidationReport): void {
    const fileName = findingManagerValidationReportFileName(report);
    const content = managerReportContent(report);
    const contentSha256 = sha256(content);
    publishReportFile({
      reportDir: this.#reportDir,
      fileName,
      content,
      publicationId: sha256(['manager-validation', fileName, contentSha256].join('\0')),
      contentSha256,
    });
  }

  planManagerValidationPublication(
    roundMarker: string,
    report: FindingManagerValidationReport,
  ): FindingManagerReportPublication {
    if (report.runId !== this.#runId) {
      throw new Error(
        `Finding manager report run id "${report.runId}" does not match publication destination "${this.#runId}"`,
      );
    }
    const fileName = findingManagerValidationReportFileName(report);
    const contentSha256 = sha256(managerReportContent(report));
    return {
      publicationId: computeFindingManagerReportPublicationId({
        roundMarker,
        originRunId: this.#runId,
        fileName,
        contentSha256,
      }),
      domainId: this.#domainId,
      originRunId: this.#runId,
      destinationRunId: this.#runId,
      fileName,
      contentSha256,
      report,
    };
  }

  publishManagerValidationPublication(
    publication: FindingManagerReportPublication,
  ): ReportPublicationReceipt {
    return publishReportFile({
      reportDir: this.#reportDir,
      fileName: publication.fileName,
      content: managerReportContent(publication.report),
      publicationId: publication.publicationId,
      contentSha256: publication.contentSha256,
    });
  }

  validatePublicationReceipt(
    publication: FindingManagerReportPublication,
    receipt: ReportPublicationReceipt,
  ): void {
    const targetPath = resolve(this.#reportDir, publication.fileName);
    if (receipt.publicationId !== publication.publicationId
      || receipt.streamId !== reportPublicationStreamId(targetPath)
      || receipt.revision !== publication.contentSha256
      || receipt.contentSha256 !== publication.contentSha256) {
      throw new Error(
        `Report publication receipt does not match "${publication.publicationId}"`,
      );
    }
  }

  finalizeManagerValidationPublication<Result>(
    publication: FindingManagerReportPublication,
    receipt: ReportPublicationReceipt,
    finalize: () => Result,
  ): Result {
    return finalizeReportPublication(receipt, {
      reportDir: this.#reportDir,
      targetPath: resolve(this.#reportDir, publication.fileName),
      publicationId: publication.publicationId,
      contentSha256: publication.contentSha256,
    }, finalize);
  }

}
