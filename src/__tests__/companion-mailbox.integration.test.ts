import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
    expect(rows[0]).toEqual({
      companion: 'security-reviewer',
      reviewedAt: '2026-08-14T00:00:00.000Z',
      reviewedDigest: 'digest-1',
      severity: 'must_fix',
      file: 'src/a.ts',
      line: 3,
      finding: 'first',
    });
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

  it('uses the injected central run root instead of rebuilding project .takt/runs', () => {
    const project = mkdtempSync(join(tmpdir(), 'takt-companion-project-'));
    roots.push(project);
    const centralRunRoot = join(project, 'central-state', 'runs', 'run-1');
    const path = buildCompanionMailboxPath({
      cwd: project,
      runRootDirectory: centralRunRoot,
      runSlug: 'run-1',
      runPathNamespace: [],
      stepName: 'implement',
      companionName: 'reviewer',
    });

    expect(path).toBe(join(centralRunRoot, 'companion', 'implement', 'reviewer.jsonl'));
    expect(path).not.toContain(join('.takt', 'runs'));
  });

  it('rejects appending after the mailbox is replaced with a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-mailbox-symlink-'));
    roots.push(root);
    const path = buildCompanionMailboxPath({
      cwd: root,
      runSlug: 'run-1',
      runPathNamespace: [],
      stepName: 'implement',
      companionName: 'security-reviewer',
    });
    const input = {
      path,
      companionName: 'security-reviewer',
      reviewedAt: '2026-08-14T00:00:00.000Z',
      reviewedDigest: 'digest-3',
      findings: [{ severity: 'must_fix' as const, file: 'src/a.ts', line: 3, finding: 'first' }],
    };
    appendCompanionMailboxFindings(input);

    const outside = join(root, 'outside.jsonl');
    writeFileSync(outside, 'outside\n', 'utf8');
    unlinkSync(path);
    symlinkSync(outside, path);

    expect(() => appendCompanionMailboxFindings(input)).toThrow(/symlink/);
    expect(readFileSync(outside, 'utf8')).toBe('outside\n');
  });
});
