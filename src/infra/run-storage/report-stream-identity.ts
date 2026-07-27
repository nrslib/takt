import {
  classifyReportRelativePath,
  reportPathRejectionMessage,
} from '../../core/models/reserved-report-names.js';
import { sha256 } from './canonical-json.js';

declare const reportStreamIdentityBrand: unique symbol;
const PUBLIC_REPORT_STREAM_IDENTITIES = new WeakSet<object>();

export interface PublicReportStreamIdentity {
  readonly [reportStreamIdentityBrand]: true;
  readonly name: string;
  readonly portableIdentity: string;
}

export function assertPublicReportStreamIdentity(
  identity: unknown,
  context: string,
): asserts identity is PublicReportStreamIdentity {
  if (
    typeof identity !== 'object'
    || identity === null
    || !PUBLIC_REPORT_STREAM_IDENTITIES.has(identity)
  ) {
    throw new Error(
      `${context}: report stream identity did not come from the public report path boundary`,
    );
  }
}

export function createPublicReportStreamIdentity(
  streamName: string,
): PublicReportStreamIdentity {
  const classification = classifyReportRelativePath(streamName);
  if (classification.kind !== 'public') {
    throw new Error(`Report path ${reportPathRejectionMessage(streamName)}`);
  }
  const identity = Object.freeze({
    name: streamName,
    portableIdentity: classification.portableIdentity,
  }) as PublicReportStreamIdentity;
  PUBLIC_REPORT_STREAM_IDENTITIES.add(identity);
  return identity;
}

export function derivePublicReportStreamId(
  runId: string,
  ownerScopeId: string,
  identity: PublicReportStreamIdentity,
): string {
  assertPublicReportStreamIdentity(identity, 'derivePublicReportStreamId');
  return sha256([runId, ownerScopeId, identity.portableIdentity].join('\0'));
}

export function reconstructPublicReportStreamIdentity(input: {
  readonly streamName: string;
  readonly portableIdentity: string;
}): PublicReportStreamIdentity {
  const identity = createPublicReportStreamIdentity(input.streamName);
  if (identity.portableIdentity !== input.portableIdentity) {
    throw new Error(
      `Report stream portable identity mismatch for "${input.streamName}"`,
    );
  }
  return identity;
}

export function validateStoredReportStreamIdentity(input: {
  readonly runId: string;
  readonly ownerScopeId: string;
  readonly streamId: string;
  readonly streamName: string;
  readonly portableIdentity: string;
}): PublicReportStreamIdentity {
  const identity = reconstructPublicReportStreamIdentity(input);
  if (
    input.streamId !== derivePublicReportStreamId(
      input.runId,
      input.ownerScopeId,
      identity,
    )
  ) {
    throw new Error(`Report stream identity mismatch for "${input.streamId}"`);
  }
  return identity;
}
