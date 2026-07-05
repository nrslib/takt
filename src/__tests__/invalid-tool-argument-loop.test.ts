import { describe, it, expect } from 'vitest';
import { InvalidToolArgumentLoopDetector } from '../infra/opencode/unavailable-tool-loop.js';

const SCHEMA_ERROR = 'The read tool was called with invalid arguments: SchemaError(Expected string)';

describe('InvalidToolArgumentLoopDetector', () => {
  it('should trip after four consecutive argument errors on the same tool', () => {
    const detector = new InvalidToolArgumentLoopDetector();

    expect(detector.observe('c1', 'read', SCHEMA_ERROR)).toBeUndefined();
    expect(detector.observe('c2', 'read', SCHEMA_ERROR)).toBeUndefined();
    expect(detector.observe('c3', 'read', SCHEMA_ERROR)).toBeUndefined();
    expect(detector.observe('c4', 'read', SCHEMA_ERROR)).toContain('invalid tool argument loop');
  });

  it('should restart the count when the failing tool changes', () => {
    const detector = new InvalidToolArgumentLoopDetector();

    detector.observe('c1', 'read', SCHEMA_ERROR);
    detector.observe('c2', 'read', SCHEMA_ERROR);
    detector.observe('c3', 'read', SCHEMA_ERROR);
    expect(detector.observe('c4', 'edit', SCHEMA_ERROR)).toBeUndefined();
    expect(detector.observe('c5', 'edit', SCHEMA_ERROR)).toBeUndefined();
  });

  it('should reset the count on a non-argument error', () => {
    const detector = new InvalidToolArgumentLoopDetector();

    detector.observe('c1', 'read', SCHEMA_ERROR);
    detector.observe('c2', 'read', SCHEMA_ERROR);
    detector.observe('c3', 'read', 'file not found');

    expect(detector.observe('c4', 'read', SCHEMA_ERROR)).toBeUndefined();
  });

  it('should reset the count when reset() is called', () => {
    const detector = new InvalidToolArgumentLoopDetector();

    detector.observe('c1', 'read', SCHEMA_ERROR);
    detector.observe('c2', 'read', SCHEMA_ERROR);
    detector.reset();

    expect(detector.observe('c3', 'read', SCHEMA_ERROR)).toBeUndefined();
  });

  it('should ignore duplicate observations for the same call id', () => {
    const detector = new InvalidToolArgumentLoopDetector();

    detector.observe('c1', 'read', SCHEMA_ERROR);
    detector.observe('c1', 'read', SCHEMA_ERROR);
    detector.observe('c1', 'read', SCHEMA_ERROR);
    detector.observe('c2', 'read', SCHEMA_ERROR);
    detector.observe('c3', 'read', SCHEMA_ERROR);
    expect(detector.observe('c4', 'read', SCHEMA_ERROR)).toContain('invalid tool argument loop');
  });
});
