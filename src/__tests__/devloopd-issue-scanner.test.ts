import { describe, expect, it } from 'vitest';
import {
  classifyIssue,
  formatIssueScanReport,
  scanIssues,
  type DevloopIssueScannerCommandRunner,
} from '../devloopd/issueScanner.js';

interface ExecCall {
  command: string;
  args: readonly string[];
}

function makeRunner(issues: unknown[]): DevloopIssueScannerCommandRunner & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    resolveCommand(command) {
      return command === 'gh' ? '/mock/bin/gh' : undefined;
    },
    async exec(command, args) {
      calls.push({ command, args });
      return { exitCode: 0, stdout: JSON.stringify(issues), stderr: '' };
    },
  };
}

describe('devloopd issue scanner', () => {
  it('classifies ready low-risk issues as auto-merge candidates', () => {
    const candidate = classifyIssue({
      number: 123,
      title: 'Fix docs typo',
      body: 'Small documentation typo.',
      url: 'https://github.com/owner/repo/issues/123',
      labels: ['agent:ready', 'docs'],
      updatedAt: '2026-06-24T00:00:00Z',
      comments: 1,
    });

    expect(candidate.mode).toBe('auto_merge_candidate');
    expect(candidate.mechanicalRisk).toBe('low');
    expect('body' in candidate).toBe(false);
  });

  it('skips issues with forbidden labels', () => {
    const candidate = classifyIssue({
      number: 124,
      title: 'Fix payment bug',
      body: 'Payment issue',
      url: 'https://github.com/owner/repo/issues/124',
      labels: ['agent:ready', 'billing'],
      updatedAt: '2026-06-24T00:00:00Z',
      comments: 0,
    });

    expect(candidate.mode).toBe('skip');
    expect(candidate.reason).toContain('forbidden label: billing');
  });

  it('marks secret, CI bypass, and admin requests as human required', () => {
    const candidate = classifyIssue({
      number: 125,
      title: 'Need admin merge',
      body: 'Please bypass CI and read .env to debug the secret.',
      url: 'https://github.com/owner/repo/issues/125',
      labels: ['agent:ready'],
      updatedAt: '2026-06-24T00:00:00Z',
      comments: 0,
    });

    expect(candidate.mode).toBe('human_required');
    expect(candidate.reason).toContain('unsafe request');
  });

  it('scans GitHub issues with mechanical filters', async () => {
    const runner = makeRunner([
      {
        number: 123,
        title: 'Fix docs typo',
        body: 'Small documentation typo.',
        url: 'https://github.com/owner/repo/issues/123',
        labels: [{ name: 'agent:ready' }, { name: 'docs' }],
        updatedAt: '2026-06-24T00:00:00Z',
        comments: [{ body: 'thanks' }],
      },
      {
        number: 124,
        title: 'Payment bug',
        body: 'Payment issue',
        url: 'https://github.com/owner/repo/issues/124',
        labels: [{ name: 'billing' }],
        updatedAt: '2026-06-24T00:00:00Z',
        comments: [],
      },
    ]);

    const report = await scanIssues({
      repoPath: '/repo',
      repo: 'owner/repo',
      runner,
    });

    expect(report.passed).toBe(true);
    expect(report.candidates.map((candidate) => candidate.number)).toEqual([123]);
    expect(report.skipped.map((candidate) => candidate.number)).toEqual([124]);
    expect(formatIssueScanReport(report)).toContain('#123');
    expect(runner.calls[0]).toEqual({
      command: '/mock/bin/gh',
      args: [
        'issue',
        'list',
        '--state',
        'open',
        '--json',
        'number,title,body,labels,assignees,updatedAt,url,comments',
        '--limit',
        '50',
        '--repo',
        'owner/repo',
      ],
    });
  });

  it('fails cleanly when gh is unavailable', async () => {
    const runner: DevloopIssueScannerCommandRunner = {
      resolveCommand: () => undefined,
      async exec() {
        throw new Error('should not execute');
      },
    };

    const report = await scanIssues({ repoPath: '/repo', runner });

    expect(report.passed).toBe(false);
    expect(formatIssueScanReport(report)).toContain('command not found: gh');
  });

  it('classifies GitHub rate limit failures with retry hints', async () => {
    const runner: DevloopIssueScannerCommandRunner = {
      resolveCommand(command) {
        return command === 'gh' ? '/mock/bin/gh' : undefined;
      },
      async exec() {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'API rate limit exceeded. retry after 60 seconds',
        };
      },
    };

    const report = await scanIssues({ repoPath: '/repo', runner });
    const output = formatIssueScanReport(report);

    expect(report.passed).toBe(false);
    expect(report.failureKind).toBe('rate_limited');
    expect(report.retryAfterSeconds).toBe(60);
    expect(output).toContain('rate limited');
    expect(output).toContain('Retry after: 60s');
  });

  it('fails cleanly when gh returns invalid JSON', async () => {
    const runner: DevloopIssueScannerCommandRunner = {
      resolveCommand(command) {
        return command === 'gh' ? '/mock/bin/gh' : undefined;
      },
      async exec() {
        return { exitCode: 0, stdout: '{not json', stderr: '' };
      },
    };

    const report = await scanIssues({ repoPath: '/repo', runner });

    expect(report.passed).toBe(false);
    expect(report.failureKind).toBe('gh_error');
    expect(formatIssueScanReport(report)).toContain('invalid JSON');
  });
});
