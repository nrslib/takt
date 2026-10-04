import { describe, expect, it } from 'vitest';
import { restoreResumeNamespace, saveResumeNamespace } from '../src/resume-codec.js';

describe('resume namespace', () => {
  it('stores and restores the current namespace', () => {
    const namespace = saveResumeNamespace(['root', 'build']);
    expect(namespace).toBe('iteration-1--step-build');
    expect(restoreResumeNamespace(namespace)).toBe('build');
  });
});
