import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  restoreTaktEnv,
  snapshotTaktEnv,
  type TaktEnvSnapshot,
} from './taktEnv.js';

const TAKT_EXISTING_KEY = 'TAKT_ENV_HELPER_TEST_EXISTING';
const TAKT_ADDED_KEY = 'TAKT_ENV_HELPER_TEST_ADDED';
const NON_TAKT_KEY = 'NODE_ENV_HELPER_TEST_VALUE';

let originalTaktEnv: TaktEnvSnapshot;
let originalNonTaktValue: string | undefined;

beforeEach(() => {
  originalTaktEnv = snapshotTaktEnv();
  originalNonTaktValue = process.env[NON_TAKT_KEY];
  delete process.env[TAKT_EXISTING_KEY];
  delete process.env[TAKT_ADDED_KEY];
  delete process.env[NON_TAKT_KEY];
});

afterEach(() => {
  restoreTaktEnv(originalTaktEnv);
  if (originalNonTaktValue === undefined) {
    delete process.env[NON_TAKT_KEY];
  } else {
    process.env[NON_TAKT_KEY] = originalNonTaktValue;
  }
});

describe('takt env helpers', () => {
  it('should restore TAKT values captured in the snapshot', () => {
    process.env[TAKT_EXISTING_KEY] = 'before';
    const snapshot = snapshotTaktEnv();

    process.env[TAKT_EXISTING_KEY] = 'after';

    restoreTaktEnv(snapshot);

    expect(process.env[TAKT_EXISTING_KEY]).toBe('before');
  });

  it('should delete TAKT values added after the snapshot', () => {
    const snapshot = snapshotTaktEnv();

    process.env[TAKT_ADDED_KEY] = 'added';

    restoreTaktEnv(snapshot);

    expect(process.env[TAKT_ADDED_KEY]).toBeUndefined();
  });

  it('should leave non-TAKT values unchanged', () => {
    const snapshot = snapshotTaktEnv();

    process.env[NON_TAKT_KEY] = 'changed';
    process.env[TAKT_ADDED_KEY] = 'added';

    restoreTaktEnv(snapshot);

    expect(process.env[NON_TAKT_KEY]).toBe('changed');
    expect(process.env[TAKT_ADDED_KEY]).toBeUndefined();
  });
});
