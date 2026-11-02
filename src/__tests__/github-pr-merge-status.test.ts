import { beforeEach, expect, it, vi } from 'vitest';
import { fetchPrMergeStatus } from '../infra/github/pr-status.js';
import { parseGitHubPullRequestTarget } from '../infra/github/pull-request-target.js';

const command = vi.hoisted(() => vi.fn());
vi.mock('../infra/github/pr-command.js', () => ({ runPrCommand: command }));
const target = parseGitHubPullRequestTarget('https://github.com/example/project/pull/1950');
const response = () => ({ number: 1950, url: target.url, headRefName: 'takt/goal', baseRefName: 'main',
  state: 'MERGED', baseRefOid: 'b'.repeat(40), mergeCommit: { oid: 'c'.repeat(40) } });
beforeEach(() => { command.mockReset().mockResolvedValue(JSON.stringify(response())); });

it('requests merge evidence for the saved PR URL and forwards cancellation options', async () => {
  const options = { signal: new AbortController().signal };
  expect(await fetchPrMergeStatus(target, '/project', options)).toEqual(response());
  const args = command.mock.calls[0]![0] as string[];
  expect(args.slice(0, 3)).toEqual(['pr', 'view', target.url]);
  expect(args[args.indexOf('--json') + 1]?.split(',')).toEqual(expect.arrayContaining([
    'number', 'url', 'headRefName', 'baseRefName', 'state', 'baseRefOid', 'mergeCommit',
  ]));
  expect(command.mock.calls[0]?.slice(1)).toEqual(['/project', options]);
});

it.each(['OPEN', 'CLOSED', 'MERGED'])('returns the actual PR state %s without requiring a head SHA', async (state) => {
  command.mockResolvedValue(JSON.stringify({ ...response(), state }));
  expect(await fetchPrMergeStatus(target, '/project')).toMatchObject({ state });
});

it.each([
  { number: 1951 }, { url: 'https://github.com/other/project/pull/1950' },
  { headRefName: undefined }, { baseRefName: '' }, { baseRefOid: 'invalid' }, { state: 'UNKNOWN' },
  { mergeCommit: { oid: 'invalid' } }, { mergeCommit: undefined },
])('rejects mismatched or incomplete PR evidence: %j', async (overrides) => {
  command.mockResolvedValue(JSON.stringify({ ...response(), ...overrides }));
  await expect(fetchPrMergeStatus(target, '/project')).rejects.toThrow();
});

it('preserves a null merge commit so the caller can use content comparison', async () => {
  command.mockResolvedValue(JSON.stringify({ ...response(), mergeCommit: null }));
  expect(await fetchPrMergeStatus(target, '/project')).toMatchObject({ state: 'MERGED', mergeCommit: null });
});

it('rejects invalid JSON instead of supplying merge evidence', async () => {
  command.mockResolvedValue('{');
  await expect(fetchPrMergeStatus(target, '/project')).rejects.toThrow();
});

it.each(['not authenticated', 'network failure'])('propagates a gh failure: %s', async (message) => {
  const error = new Error(message);
  command.mockRejectedValue(error);
  await expect(fetchPrMergeStatus(target, '/project')).rejects.toBe(error);
});

it('propagates the command cancellation', async () => {
  const error = new DOMException('cancelled', 'AbortError');
  command.mockRejectedValue(error);
  await expect(fetchPrMergeStatus(target, '/project')).rejects.toBe(error);
});
