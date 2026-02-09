/**
 * Unit tests for error utilities
 *
 * Tests error message extraction from unknown error types.
 */

import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '../shared/utils/error.js';

describe('getErrorMessage', () => {
  it('should extract message from Error instances', () => {
    expect(getErrorMessage(new Error('test error'))).toBe('test error');
  });

  it('should extract message from Error subclasses', () => {
    expect(getErrorMessage(new TypeError('type error'))).toBe('type error');
    expect(getErrorMessage(new RangeError('range error'))).toBe('range error');
  });

  it('should convert string to message', () => {
    expect(getErrorMessage('string error')).toBe('string error');
  });

  it('should convert number to message', () => {
    expect(getErrorMessage(42)).toBe('42');
  });

  it('should convert null to message', () => {
    expect(getErrorMessage(null)).toBe('null');
  });

  it('should convert undefined to message', () => {
    expect(getErrorMessage(undefined)).toBe('undefined');
  });

  it('should convert object to message', () => {
    expect(getErrorMessage({ code: 'ERR' })).toBe('[object Object]');
  });
});
