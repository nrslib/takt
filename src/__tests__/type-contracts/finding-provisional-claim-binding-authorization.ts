import type {
  FindingProvisionalClaimBindingAuthorization,
} from '../../core/models/finding-types.js';

declare const authorization: FindingProvisionalClaimBindingAuthorization;

const spreadAuthorization = { ...authorization };
const plainAuthorization = { reference: authorization.reference };

// @ts-expect-error Spread results do not retain the nominal authorization identity.
const rejectedSpread: FindingProvisionalClaimBindingAuthorization = spreadAuthorization;
// @ts-expect-error Plain objects cannot provide the private authorization identity.
const rejectedPlain: FindingProvisionalClaimBindingAuthorization = plainAuthorization;

void rejectedSpread;
void rejectedPlain;
