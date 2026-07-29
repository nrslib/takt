import { expectedSchemaHashFromDdl } from './schema-hash.js';

export const APPLICATION_ID = 0x54414b54;
export const SCHEMA_VERSION = 3;

export const EXPECTED_SCHEMA_HASH = expectedSchemaHashFromDdl();
