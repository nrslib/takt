import { createHash } from 'node:crypto';
import { compareBinaryStrings } from '../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../shared/utils/canonical-json.js';
import type {
  FindingProvisionalClaimBindingAuthorization,
  FindingProvisionalClaimBindingAuthorizationReference,
} from './finding-types.js';

export type ProvisionalClaimBindingAuthorizationPayload =
  FindingProvisionalClaimBindingAuthorizationReference extends infer Authorization
  ? Authorization extends FindingProvisionalClaimBindingAuthorizationReference
    ? Omit<Authorization, 'authorizationId'>
    : never
  : never;

function authorizationPayload(
  authorization: FindingProvisionalClaimBindingAuthorizationReference,
): ProvisionalClaimBindingAuthorizationPayload {
  if (authorization.kind === 'new_provisional_bundle') {
    return {
      kind: authorization.kind,
      bindingDecisionId: authorization.bindingDecisionId,
      creationRequestKey: authorization.creationRequestKey,
      expectedHead: authorization.expectedHead,
      sourceRawFindingIds: authorization.sourceRawFindingIds,
    };
  }
  return {
    kind: authorization.kind,
    bindingDecisionId: authorization.bindingDecisionId,
    findingId: authorization.findingId,
    expectedTargetHead: authorization.expectedTargetHead,
    expectedProvisionalKind: authorization.expectedProvisionalKind,
    expectedStableKey: authorization.expectedStableKey,
    expectedLineageKey: authorization.expectedLineageKey,
    sourceRawFindingIds: authorization.sourceRawFindingIds,
  };
}

export function computeProvisionalClaimBindingAuthorizationId(
  authorization: ProvisionalClaimBindingAuthorizationPayload,
): string {
  return createHash('sha256').update(canonicalJson({
    domain: 'finding-provisional-claim-binding-authorization',
    version: 1,
    authorization,
  })).digest('hex');
}

export function createProvisionalClaimBindingAuthorizationReference<
  Authorization extends ProvisionalClaimBindingAuthorizationPayload,
>(
  authorization: Authorization,
): Authorization & { authorizationId: string } {
  return {
    ...structuredClone(authorization),
    authorizationId: computeProvisionalClaimBindingAuthorizationId(authorization),
  };
}

export function provisionalClaimBindingAuthorizationViolation(
  authorization: FindingProvisionalClaimBindingAuthorizationReference,
): string | undefined {
  const canonicalRawFindingIds = [...new Set(authorization.sourceRawFindingIds)]
    .sort(compareBinaryStrings);
  if (
    canonicalRawFindingIds.length !== authorization.sourceRawFindingIds.length
    || canonicalRawFindingIds.some(
      (rawFindingId, index) => rawFindingId !== authorization.sourceRawFindingIds[index],
    )
  ) {
    return `Provisional claim binding authorization "${authorization.authorizationId}" has a non-canonical raw finding set`;
  }
  const canonicalId = computeProvisionalClaimBindingAuthorizationId(
    authorizationPayload(authorization),
  );
  return authorization.authorizationId === canonicalId
    ? undefined
    : `Provisional claim binding authorization "${authorization.authorizationId}" does not match its canonical content address "${canonicalId}"`;
}

export function provisionalClaimBindingAuthorizationReference(
  authorization: FindingProvisionalClaimBindingAuthorization,
): FindingProvisionalClaimBindingAuthorizationReference {
  return structuredClone(authorization.reference);
}
