import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { PrivateDirectoryReadSnapshot } from '../shared/utils/private-file.js';
import { DebugLogger } from '../shared/utils/debug.js';
import { buildResumeReportConsumerKey } from '../core/workflow/run/resume-report-consumer.js';
import { makeWorkflowResumePointEntry } from './test-helpers.js';

type Entry = { stat: Stats; content?: Buffer };

const io = vi.hoisted(() => ({
  entries: new Map<string, Entry>(),
  read: vi.fn(),
  publish: vi.fn(),
  remove: vi.fn(),
  failReadPath: undefined as string | undefined,
  failReaddirPath: undefined as string | undefined,
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  lstatSync: (path: string) => {
    const entry = io.entries.get(path);
    if (!entry) throw Object.assign(new Error(`missing: ${path}`), { code: 'ENOENT' });
    return entry.stat;
  },
  readdirSync: (path: string) => {
    if (path === io.failReaddirPath) throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
    return [...io.entries.keys()].filter((entry) => entry !== path && dirname(entry) === path)
      .map((entry) => entry.slice(path.length + 1)).sort();
  },
}));

vi.mock('../shared/utils/private-file.js', () => ({
  capturePrivateDirectoryReadSnapshot: (path: string): PrivateDirectoryReadSnapshot => ({
    path, stat: io.entries.get(path)!.stat,
  }),
  assertPrivateDirectoryReadSnapshot: vi.fn(),
  readRegularFileNoFollow: io.read,
  ensurePrivateDirectory: (path: string) => addDirectory(path),
  writePrivateFileWithMode: (path: string, content: string | Buffer, mode: number) => {
    io.entries.set(path, { stat: stat(0o100000 | mode), content: Buffer.from(content) });
  },
  publishPrivateDirectory: io.publish,
  removePrivateDirectory: io.remove,
}));

import {
  inheritResumeReportSnapshot,
  readResumeReportSnapshotManifest,
  RESUME_ARTIFACTS_FILE_NAME,
} from '../core/workflow/run/resume-report-snapshot.js';

const cwd = '/snapshot-project';
const sourceReports = join(cwd, '.takt/runs/source-run/reports');
const targetReports = join(cwd, '.takt/runs/target-run/reports');
const options = { cwd, sourceRunSlug: 'source-run', targetRunSlug: 'target-run' };

function stat(mode: number): Stats {
  const kind = mode & 0o170000;
  return {
    mode, dev: 1, ino: 1,
    isFile: () => kind === 0o100000,
    isDirectory: () => kind === 0o40000,
    isSymbolicLink: () => kind === 0o120000,
  } as Stats;
}

function addDirectory(path: string): void {
  if (io.entries.has(path)) return;
  if (dirname(path) !== path) addDirectory(dirname(path));
  io.entries.set(path, { stat: stat(0o40700) });
}

function addFile(relativePath: string, content: string): void {
  const path = join(sourceReports, relativePath);
  addDirectory(dirname(path));
  io.entries.set(path, { stat: stat(0o100600), content: Buffer.from(content) });
}

function addSpecial(relativePath: string, mode: number): void {
  const path = join(sourceReports, relativePath);
  addDirectory(dirname(path));
  io.entries.set(path, { stat: stat(mode) });
}

describe('resume report snapshot with isolated filesystem dependencies', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    io.entries.clear();
    io.failReadPath = undefined;
    io.failReaddirPath = undefined;
    addDirectory(sourceReports);
    io.read.mockImplementation((path: string) => {
      if (path === io.failReadPath) throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
      const entry = io.entries.get(path);
      if (!entry?.stat.isFile() || entry.content === undefined) throw new Error(`not readable: ${path}`);
      return entry.content;
    });
    io.publish.mockImplementation((_parent: string, staging: string, target: string) => {
      for (const [path, entry] of [...io.entries]) {
        if (path === staging || path.startsWith(`${staging}/`)) {
          io.entries.set(target + path.slice(staging.length), entry);
          io.entries.delete(path);
        }
      }
    });
    io.remove.mockImplementation((_parent: string, staging: string) => {
      for (const path of io.entries.keys()) {
        if (path === staging || path.startsWith(`${staging}/`)) io.entries.delete(path);
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    io.entries.clear();
  });

  it('copies all regular files and persists every skipped entry without reading special entries', () => {
    addFile('plan.md', 'plan');
    addFile('deep/evidence/review.md', 'review');
    addFile('z-last.md', 'last report');
    addSpecial('file-link.md', 0o120777);
    addSpecial('deep/directory-link', 0o120777);
    addSpecial('deep/broken-link', 0o120777);
    addSpecial('deep/evidence/pipe', 0o10600);

    const manifest = inheritResumeReportSnapshot(options);
    const persisted: unknown = JSON.parse(io.entries.get(join(targetReports, RESUME_ARTIFACTS_FILE_NAME))!.content!.toString());
    const expectedPaths = ['deep/broken-link', 'deep/directory-link', 'deep/evidence/pipe', 'file-link.md'];
    const skipped = expectedPaths.map((path) => expect.objectContaining({ path, reason: expect.any(String) }));

    expect(manifest.files.map((entry) => entry.path)).toEqual(['deep/evidence/review.md', 'plan.md', 'z-last.md']);
    for (const entry of manifest.files) {
      const content = io.entries.get(join(targetReports, entry.path))!.content!;
      expect(content).toEqual(io.entries.get(join(sourceReports, entry.path))!.content);
      expect(entry.size).toBe(content.length);
      expect(entry.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    }
    expect(persisted).toEqual(expect.objectContaining({ skippedEntries: expect.arrayContaining(skipped) }));
    expect(persisted).toHaveProperty('skippedEntries.length', expectedPaths.length);
    expect(readResumeReportSnapshotManifest(cwd, 'target-run')).toEqual(persisted);
    for (const path of expectedPaths) {
      expect(io.entries.has(join(targetReports, path))).toBe(false);
      expect(io.read.mock.calls.some(([readPath]) => readPath === join(sourceReports, path))).toBe(false);
    }
  });

  it('publishes the completed reports and skipped-entry manifest together', () => {
    addFile('plan.md', 'plan');
    addSpecial('link', 0o120777);
    io.publish.mockImplementation((_parent: string, staging: string, target: string) => {
      expect(target).toBe(targetReports);
      expect(io.entries.has(targetReports)).toBe(false);
      expect(io.entries.get(join(staging, 'plan.md'))?.content?.toString()).toBe('plan');
      const persisted: unknown = JSON.parse(io.entries.get(join(staging, RESUME_ARTIFACTS_FILE_NAME))!.content!.toString());
      expect(persisted).toHaveProperty('skippedEntries', [expect.objectContaining({ path: 'link' })]);
    });

    inheritResumeReportSnapshot(options);

    expect(io.publish).toHaveBeenCalledTimes(1);
  });

  it('accepts an existing empty reports directory', () => {
    const manifest = inheritResumeReportSnapshot(options);
    expect(manifest.files).toEqual([]);
    expect(readResumeReportSnapshotManifest(cwd, 'target-run')).toEqual(manifest);
    expect(io.publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not an array', null],
    ['invalid entry', [null]],
    ['extra field', [{ path: 'link', reason: 'symlink', target: '/outside' }]],
    ['escaping path', [{ path: '../outside', reason: 'symlink' }]],
    ['internal path', [{ path: '.takt-report-internal/link', reason: 'symlink' }]],
    ['unknown reason', [{ path: 'link', reason: 'unreadable' }]],
    ['duplicate path', [{ path: 'link', reason: 'symlink' }, { path: 'link', reason: 'non_regular' }]],
    ['copied path', [{ path: 'plan.md', reason: 'symlink' }]],
  ])('rejects an invalid persisted skipped-entry list: %s', (_name, skippedEntries) => {
    addFile('plan.md', 'plan');
    const manifest = inheritResumeReportSnapshot(options);
    const path = join(targetReports, RESUME_ARTIFACTS_FILE_NAME);
    io.entries.set(path, {
      stat: stat(0o100600),
      content: Buffer.from(JSON.stringify({ ...manifest, skippedEntries })),
    });

    expect(() => readResumeReportSnapshotManifest(cwd, 'target-run')).toThrow();
  });

  it.each([1, 2])('reads an existing version %s manifest without skipped entries', (version) => {
    const path = join(targetReports, RESUME_ARTIFACTS_FILE_NAME);
    addDirectory(targetReports);
    io.entries.set(path, {
      stat: stat(0o100600),
      content: Buffer.from(JSON.stringify({
        version, sourceRunSlug: 'source-run', targetRunSlug: 'target-run',
        createdAt: '2026-10-09T00:00:00.000Z', files: [],
      })),
    });

    expect(readResumeReportSnapshotManifest(cwd, 'target-run')).toMatchObject({
      version, sourceRunSlug: 'source-run', targetRunSlug: 'target-run', files: [],
    });
  });

  it('drops only persisted consumers without call instances and retains files, skipped entries and valid mappings', () => {
    addFile('plan.md', 'plan');
    addSpecial('link', 0o120777);
    const manifest = inheritResumeReportSnapshot(options);
    const call = makeWorkflowResumePointEntry({ workflow: 'parent', workflow_ref: 'parent', step: 'delegate', kind: 'workflow_call', call_instance: 1 });
    const currentKey = buildResumeReportConsumerKey('child', 'consume', [call]);
    const rootKey = buildResumeReportConsumerKey('parent', 'consume', []);
    const legacyKey = JSON.stringify({ workflow: 'child', step: 'consume', calls: [{ workflow: 'parent', step: 'delegate', kind: 'workflow_call' }] });
    const consumer = (consumerKey: string) => ({ consumerKey, reportDirectories: [''], references: [{ reference: 'plan.md', path: 'plan.md' }] });
    const validConsumers = [consumer(currentKey), consumer(rootKey)];
    const path = join(targetReports, RESUME_ARTIFACTS_FILE_NAME);
    io.entries.set(path, {
      stat: stat(0o100600),
      content: Buffer.from(JSON.stringify({ ...manifest, resumeReportConsumers: [validConsumers[0], consumer(legacyKey), validConsumers[1]] })),
    });
    const warnings = vi.spyOn(DebugLogger.getInstance(), 'writeLog');

    const restored = readResumeReportSnapshotManifest(cwd, 'target-run');

    expect(restored).toEqual({ ...manifest, resumeReportConsumers: validConsumers });
    expect(warnings.mock.calls.filter(([level, component]) => level === 'WARN' && component === 'resume-report-snapshot'))
      .toEqual([[expect.any(String), 'resume-report-snapshot', expect.any(String), { consumerKey: legacyKey }]]);
  });

  it.each(['directory', 'reference'])('still rejects an invalid %s in a legacy consumer', (invalid) => {
    addFile('plan.md', 'plan');
    const manifest = inheritResumeReportSnapshot(options);
    const path = join(targetReports, RESUME_ARTIFACTS_FILE_NAME);
    io.entries.set(path, {
      stat: stat(0o100600),
      content: Buffer.from(JSON.stringify({ ...manifest, resumeReportConsumers: [{
        consumerKey: JSON.stringify({ workflow: 'child', step: 'consume', calls: [{ workflow: 'parent', step: 'delegate', kind: 'workflow_call' }] }),
        reportDirectories: invalid === 'directory' ? ['../outside'] : [''],
        references: [{ reference: 'plan.md', path: invalid === 'reference' ? 'missing.md' : 'plan.md' }],
      }] })),
    });

    expect(() => readResumeReportSnapshotManifest(cwd, 'target-run')).toThrow();
  });

  it.each(['source run', 'reports directory', 'directory traversal', 'regular file read'])('rejects unavailable %s without publishing reports', (failure) => {
    addFile('a-first.md', 'first');
    addFile('z-last.md', 'last');
    if (failure === 'source run') {
      for (const path of io.entries.keys()) {
        if (path.startsWith(join(cwd, '.takt/runs/source-run'))) io.entries.delete(path);
      }
    } else if (failure === 'reports directory') {
      for (const path of io.entries.keys()) {
        if (path.startsWith(sourceReports)) io.entries.delete(path);
      }
    } else if (failure === 'directory traversal') {
      io.failReaddirPath = sourceReports;
    } else {
      io.failReadPath = join(sourceReports, 'z-last.md');
    }

    expect(() => inheritResumeReportSnapshot(options)).toThrow();
    expect(io.publish).not.toHaveBeenCalled();
    expect(io.entries.has(targetReports)).toBe(false);
    expect([...io.entries.keys()].some((path) => path.includes('.reports-inherit-tmp-'))).toBe(false);
  });

  it('does not publish reports when final publication fails', () => {
    addFile('plan.md', 'plan');
    io.publish.mockImplementation(() => { throw new Error('publication failed'); });
    expect(() => inheritResumeReportSnapshot(options)).toThrow('publication failed');
    expect(io.entries.has(targetReports)).toBe(false);
    expect([...io.entries.keys()].some((path) => path.includes('.reports-inherit-tmp-'))).toBe(false);
  });
});
