import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

const removedMessage = /is removed; migrate to review-adjudication \+ requirement scenarios \+ final-gate/;
const contractKey = ['finding', 'contract'].join('_');
const authorityKey = ['finding', 'contract', 'authority'].join('_');
const requirementKey = ['requires', 'finding', 'contract'].join('_');
const roots: string[] = [];

vi.mock('node:sqlite', () => ({ DatabaseSync: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function workflowWith(extra: Record<string, unknown>) {
  return {
    name: 'removed-syntax',
    steps: [{
      name: 'review',
      persona: 'reviewer',
      instruction: 'Review.',
      rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
    }],
    ...extra,
  };
}

describe('removed workflow syntax', () => {
  it.each([
    ['top-level contract', workflowWith({
      [contractKey]: {},
    })],
    ['call authority', workflowWith({
      steps: [{
        name: 'call',
        kind: 'workflow_call',
        call: 'child',
        [authorityKey]: 'terminal_adjudication',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    })],
    ['subworkflow requirement', workflowWith({
      subworkflow: {
        callable: true,
        [requirementKey]: true,
      },
    })],
    ['team leader mode', workflowWith({
      steps: [{
        name: 'lead',
        persona: 'leader',
        instruction: 'Lead.',
        team_leader: { mode: ['finding', 'contract', 'fix'].join('_') },
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    })],
    ['findings rule', workflowWith({
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review.',
        rules: [{ condition: `when(${'findings'}.open.count == 0)`, next: 'COMPLETE' }],
      }],
    })],
  ])('rejects %s with migration guidance', (_label, raw) => {
    expect(() => normalizeWorkflowConfig(raw, '/tmp/project')).toThrow(removedMessage);
  });

  it('rejects removed syntax before opening a residual database', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-removed-workflow-'));
    roots.push(root);
    const databasePath = join(root, ['finding', 'contract.sqlite'].join('-'));
    const residualBytes = Buffer.from('residual database bytes');
    writeFileSync(databasePath, residualBytes);

    expect(() => normalizeWorkflowConfig(workflowWith({
      [contractKey]: {},
    }), root)).toThrow(removedMessage);
    expect(DatabaseSync).not.toHaveBeenCalled();
    expect(readFileSync(databasePath)).toEqual(residualBytes);
  });
});
