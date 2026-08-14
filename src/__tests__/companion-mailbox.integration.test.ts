import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendCompanionMailboxFindings,
  buildCompanionMailboxPath,
} from '../core/workflow/companion/mailbox.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('companion mailbox', () => {
  it('appends one self-contained NDJSON row per accepted finding', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-mailbox-'));
    roots.push(root);
    const path = buildCompanionMailboxPath({
      cwd: root,
      runSlug: 'run-1',
      runPathNamespace: [],
      stepName: 'implement',
      companionName: 'security-reviewer',
    });

    const rows = appendCompanionMailboxFindings({
      path,
      companionName: 'security-reviewer',
      reviewedAt: '2026-08-14T00:00:00.000Z',
      reviewedDigest: 'digest-1',
      findings: [
        { severity: 'must_fix', file: 'src/a.ts', line: 3, finding: 'first' },
        { severity: 'nit', file: 'src/b.ts', line: 4, finding: 'second' },
      ],
    });

    const persisted = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(persisted).toEqual(rows);
    expect(rows[0]).toMatchObject({
      companion: 'security-reviewer',
      reviewedAt: '2026-08-14T00:00:00.000Z',
      reviewedDigest: 'digest-1',
    });
    expect(rows[0]).not.toHaveProperty('id');
    expect(rows[0]).not.toHaveProperty('status');
  });

  it('does not read or interpret the existing audit view before appending', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-mailbox-view-'));
    roots.push(root);
    const path = join(root, 'mailbox.jsonl');
    writeFileSync(path, 'agent-owned audit text\n', 'utf8');

    expect(() => appendCompanionMailboxFindings({
      path,
      companionName: 'reviewer',
      reviewedAt: '2026-08-14T00:00:00.000Z',
      reviewedDigest: 'digest-2',
      findings: [{ severity: 'should_fix', file: 'a.ts', line: 1, finding: 'check' }],
    })).not.toThrow();
    expect(readFileSync(path, 'utf8')).toContain('agent-owned audit text\n{');
  });
});
