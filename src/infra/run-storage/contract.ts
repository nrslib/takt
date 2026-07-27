import { canonicalJson, sha256 } from './canonical-json.js';
import { expectedSchemaHashFromDdl } from './schema-hash.js';
import { OPERATION_TRANSITION_CONTRACT } from './operation-state-contract.js';
import { CODEC_CONTRACT } from './codec-contract.js';

export const APPLICATION_ID = 0x54414b54;
export const SCHEMA_VERSION = 1;

export const EXPECTED_SCHEMA_HASH = expectedSchemaHashFromDdl();

export interface StorageContractOverrides {
  readonly schemaHash?: string;
  readonly codecs?: readonly Readonly<Record<string, string>>[];
  readonly transitions?: Readonly<Record<string, readonly string[]>>;
}

export function computeStorageContractFingerprint(
  overrides: StorageContractOverrides = {},
): string {
  return sha256(canonicalJson({
    schemaHash: overrides.schemaHash ?? EXPECTED_SCHEMA_HASH,
    codecs: overrides.codecs ?? CODEC_CONTRACT,
    transitions: overrides.transitions ?? OPERATION_TRANSITION_CONTRACT,
  }));
}

export const STORAGE_CONTRACT_FINGERPRINT = computeStorageContractFingerprint();
