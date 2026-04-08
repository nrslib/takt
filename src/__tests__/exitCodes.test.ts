/**
 * Tests for exit codes
 */

import { describe, it, expect } from 'vitest';
import {
  EXIT_SUCCESS,
  EXIT_GENERAL_ERROR,
  EXIT_ISSUE_FETCH_FAILED,
  EXIT_WORKFLOW_FAILED,
  EXIT_GIT_OPERATION_FAILED,
  EXIT_PR_CREATION_FAILED,
  EXIT_SIGINT,
} from '../shared/exitCodes.js';

describe('exit codes', () => {
  it('should have distinct values', () => {
    const codes = [
      EXIT_SUCCESS,
      EXIT_GENERAL_ERROR,
      EXIT_ISSUE_FETCH_FAILED,
      EXIT_WORKFLOW_FAILED,
      EXIT_GIT_OPERATION_FAILED,
      EXIT_PR_CREATION_FAILED,
      EXIT_SIGINT,
    ];
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });

  it('should match expected values from spec', () => {
    expect(EXIT_SUCCESS).toBe(0);
    expect(EXIT_GENERAL_ERROR).toBe(1);
    expect(EXIT_ISSUE_FETCH_FAILED).toBe(2);
    expect(EXIT_WORKFLOW_FAILED).toBe(3);
    expect(EXIT_GIT_OPERATION_FAILED).toBe(4);
    expect(EXIT_PR_CREATION_FAILED).toBe(5);
    expect(EXIT_SIGINT).toBe(130);
  });
});
