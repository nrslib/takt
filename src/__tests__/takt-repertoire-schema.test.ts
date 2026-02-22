/**
 * Unit tests for takt-repertoire.yaml schema validation.
 *
 * Target: src/features/repertoire/takt-repertoire-config.ts
 *
 * Schema rules under test:
 *   - description: optional
 *   - path: optional, defaults to "."
 *   - takt.min_version: must match /^\d+\.\d+\.\d+$/ (no "v" prefix, no pre-release)
 *   - path: must not start with "/" or "~"
 *   - path: must not contain ".." segments
 */

import { describe, it, expect } from 'vitest';
import {
  parseTaktRepertoireConfig,
  validateTaktRepertoirePath,
  validateMinVersion,
} from '../features/repertoire/takt-repertoire-config.js';

describe('takt-repertoire.yaml schema: description field', () => {
  it('should accept schema without description field', () => {
    const config = parseTaktRepertoireConfig('');
    expect(config.description).toBeUndefined();
  });
});

describe('takt-repertoire.yaml schema: path field', () => {
  it('should default path to "." when not specified', () => {
    const config = parseTaktRepertoireConfig('');
    expect(config.path).toBe('.');
  });

  it('should reject path starting with "/" (absolute path)', () => {
    expect(() => validateTaktRepertoirePath('/foo')).toThrow();
  });

  it('should reject path starting with "~" (tilde-absolute path)', () => {
    expect(() => validateTaktRepertoirePath('~/foo')).toThrow();
  });

  it('should reject path with ".." segment traversing outside repository', () => {
    expect(() => validateTaktRepertoirePath('../outside')).toThrow();
  });

  it('should reject path with embedded ".." segments leading outside repository', () => {
    expect(() => validateTaktRepertoirePath('sub/../../../outside')).toThrow();
  });

  it('should accept valid relative path "sub/dir"', () => {
    expect(() => validateTaktRepertoirePath('sub/dir')).not.toThrow();
  });
});

describe('takt-repertoire.yaml schema: takt.min_version field', () => {
  it('should accept min_version "0.5.0" (valid semver)', () => {
    expect(() => validateMinVersion('0.5.0')).not.toThrow();
  });

  it('should accept min_version "1.0.0" (valid semver)', () => {
    expect(() => validateMinVersion('1.0.0')).not.toThrow();
  });

  it('should reject min_version "1.0" (missing patch segment)', () => {
    expect(() => validateMinVersion('1.0')).toThrow();
  });

  it('should reject min_version "v1.0.0" (v prefix not allowed)', () => {
    expect(() => validateMinVersion('v1.0.0')).toThrow();
  });

  it('should reject min_version "1.0.0-alpha" (pre-release suffix not allowed)', () => {
    expect(() => validateMinVersion('1.0.0-alpha')).toThrow();
  });

  it('should reject min_version "1.0.0-beta.1" (pre-release suffix not allowed)', () => {
    expect(() => validateMinVersion('1.0.0-beta.1')).toThrow();
  });
});
