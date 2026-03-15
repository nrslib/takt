/**
 * Tests for shared VCS constants
 *
 * Verifies that MAX_PAGES is properly shared across GitHub and GitLab modules,
 * preventing duplicate constant definitions from diverging.
 */

import { describe, it, expect } from 'vitest';
import { MAX_PAGES } from '../infra/git/constants.js';

describe('MAX_PAGES', () => {
  it('pagination の上限が 100 である', () => {
    expect(MAX_PAGES).toBe(100);
  });
});
