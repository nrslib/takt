import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCopiedStepFragmentReferences } from '../../features/repertoire/step-fragment-integrity.js';
import {
  captureConfigError,
  extractConfigErrorMessages,
} from '../helpers/step-fragment-test-helpers.js';

describe('step fragment package integrity', () => {
  let packageRoot: string;

  beforeEach(() => {
    packageRoot = mkdtempSync(join(tmpdir(), 'takt-step-fragment-integrity-'));
    mkdirSync(join(packageRoot, 'steps'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(packageRoot)) rmSync(packageRoot, { recursive: true, force: true });
  });

  it('rejects a workflow reference to an excluded package-local fragment before installation', () => {
    writeFileSync(join(packageRoot, 'steps', 'review.yaml'), 'instruction: review\n');

    expect(() => assertCopiedStepFragmentReferences({
      sources: [{ path: 'workflows/default.yaml', content: 'steps:\n  - uses: review\n' }],
      packageRoot,
      copiedStepNames: new Set(),
      owner: 'owner',
      repo: 'repo',
    })).toThrow('Step fragment "review" referenced by workflows/default.yaml is excluded from package installation');
  });

  it('accepts copied and externally scoped references', () => {
    writeFileSync(join(packageRoot, 'steps', 'review.yaml'), 'instruction: review\n');

    expect(() => assertCopiedStepFragmentReferences({
      sources: [{ path: 'steps/entry.yaml', content: 'uses: "@other/package/review"\nparallel:\n  - uses: review\n' }],
      packageRoot,
      copiedStepNames: new Set(['review']),
      owner: 'owner',
      repo: 'repo',
    })).not.toThrow();
  });

  it('ignores uses values in MCP environment and header records', () => {
    writeFileSync(join(packageRoot, 'steps', 'review.yaml'), 'instruction: review\n');

    expect(() => assertCopiedStepFragmentReferences({
      sources: [{
        path: 'workflows/default.yaml',
        content: [
          'steps:',
          '  - name: review',
          '    instruction: review',
          '    mcp_servers:',
          '      local:',
          '        command: server',
          '        env:',
          '          uses: review',
          '      remote:',
          '        type: http',
          '        url: https://example.test/mcp',
          '        headers:',
          '          uses: review',
          '    rules:',
          '      - condition: done',
          '        next: COMPLETE',
          '',
        ].join('\n'),
      }],
      packageRoot,
      copiedStepNames: new Set(),
      owner: 'owner',
      repo: 'repo',
    })).not.toThrow();
  });

  it.each(['workflows/default.yaml', 'steps/review.yaml'])('includes the malformed YAML source and cause for %s', (path) => {
    const error = captureConfigError(() => {
      assertCopiedStepFragmentReferences({
        sources: [{ path, content: 'uses: [' }],
        packageRoot,
        copiedStepNames: new Set(),
        owner: 'owner',
        repo: 'repo',
      });
    });

    expect(error.cause).toBeInstanceOf(Error);
    expect(extractConfigErrorMessages(error)).toContain(path);
  });

  it.each(['workflows/default.yaml', 'steps/review.yaml'])('includes the circular YAML source and cause for %s', (path) => {
    const content = path.startsWith('workflows/')
      ? 'steps:\n  - &step\n    parallel:\n      - *step\n'
      : '&step\nparallel:\n  - *step\n';
    const error = captureConfigError(() => {
      assertCopiedStepFragmentReferences({
        sources: [{ path, content }],
        packageRoot,
        copiedStepNames: new Set(),
        owner: 'owner',
        repo: 'repo',
      });
    });

    expect(error.cause).toBeInstanceOf(Error);
    expect(extractConfigErrorMessages(error)).toContain(path);
  });
});
