import { serializeCheckpoint } from './checkpoint.js';
import { createPrimaryKey } from './primary-key.js';
import { createPublicKey } from './public-key.js';
import { createIdentityCard } from './identity-card.js';
import { resourceRecord } from './resource-record.js';
import { resourceText } from './resource-text.js';
import { createRetryToken } from './retry-token.js';
import { encodeStructuredKey } from './structured-key.js';

export function publishResource(resource, state) {
  return {
    primary: createPrimaryKey(resource),
    structured: encodeStructuredKey(resource),
    retry: createRetryToken(resource),
    checkpoint: serializeCheckpoint(resource),
    public: createPublicKey(resource),
    card: createIdentityCard(resource),
    record: resourceRecord(resource, state),
    text: resourceText(resource),
  };
}
