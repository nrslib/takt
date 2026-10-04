import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLoopAnalysisJobPaths,
  readLoopAnalysisJob,
  readLoopAnalysisPublicationMarker,
  writeLoopAnalysisJob,
  writeLoopAnalysisPublicationMarker,
  type LoopAnalysisJob,
} from '../features/tasks/execute/loopAnalysisJob.js';

describe('loop analysis private job', () => {
  const tempDirectories: string[] = [];

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createPaths() {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-job-'));
    tempDirectories.push(projectCwd);
    const sourceRunDirectory = join(projectCwd, '.takt', 'runs', 'source-run');
    mkdirSync(sourceRunDirectory, { recursive: true });
    return {
      projectCwd,
      sourceRunDirectory,
      ...createLoopAnalysisJobPaths(sourceRunDirectory),
    };
  }

  it('Given a valid PR publication job, When it is persisted, Then the versioned JSON is private and restores without conversion', () => {
    const paths = createPaths();
    const job: LoopAnalysisJob = {
      version: 1,
      projectCwd: paths.projectCwd,
      sourceRunDirectory: paths.sourceRunDirectory,
      output: 'pr-comment',
      parentPid: 4321,
      branch: 'takt/source-run',
      publicationMarkerPath: paths.publicationMarkerPath,
    };

    writeLoopAnalysisJob(paths.jobPath, job);

    expect(readLoopAnalysisJob(paths.jobPath)).toEqual(job);
    if (process.platform !== 'win32') {
      expect(statSync(paths.jobPath).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ['an unsupported version', { version: 2 }, /version/i],
    ['a relative project path', { projectCwd: 'project' }, /absolute path/i],
    ['a relative source run path', { sourceRunDirectory: '.takt/runs/source' }, /absolute path/i],
    ['an invalid output', { output: 'terminal' }, /output/i],
    ['a non-string assignment', { runtimeAssignment: 1 }, /runtimeAssignment/i],
    ['a null assignment', { runtimeAssignment: null }, /runtimeAssignment/i],
    ['an explicitly undefined assignment', { runtimeAssignment: undefined }, /runtimeAssignment/i],
    ['a relative runtime file path', { runtimeFilePath: 'runtime.cost.yaml' }, /absolute path/i],
    ['an empty runtime file path', { runtimeFilePath: '' }, /runtimeFilePath/i],
    ['a non-positive parent PID', { parentPid: 0 }, /positive integer/i],
    ['only a publication branch', { output: 'pr-comment', branch: 'takt/source' }, /unknown or missing fields/i],
    ['only a publication marker', { output: 'pr-comment', publicationMarkerPath: '/project/publication.json' }, /unknown or missing fields/i],
    ['an empty publication branch with an empty assignment', {
      output: 'pr-comment', runtimeAssignment: '', branch: '', publicationMarkerPath: '/project/publication.json',
    }, /branch/i],
    ['a relative publication marker', {
      output: 'pr-comment', branch: 'takt/source', publicationMarkerPath: 'publication.json',
    }, /absolute path/i],
  ])('Given %s, When a job is written, Then strict validation rejects it', (_label, change, error) => {
    const paths = createPaths();
    const invalidJob = {
      version: 1,
      projectCwd: paths.projectCwd,
      sourceRunDirectory: paths.sourceRunDirectory,
      output: 'file',
      parentPid: 4321,
      ...change,
    };

    expect(() => writeLoopAnalysisJob(paths.jobPath, invalidJob as LoopAnalysisJob))
      .toThrow(error);
    expect(existsSync(paths.jobPath)).toBe(false);
  });

  it('Given a persisted job contains an unknown field, When the worker restores it, Then strict validation rejects the input', () => {
    const paths = createPaths();
    const job: LoopAnalysisJob = {
      version: 1,
      projectCwd: paths.projectCwd,
      sourceRunDirectory: paths.sourceRunDirectory,
      output: 'file',
      parentPid: 4321,
    };
    writeLoopAnalysisJob(paths.jobPath, job);
    writeFileSync(paths.jobPath, `${JSON.stringify({ ...job, legacy: true })}\n`, {
      mode: 0o600,
    });

    expect(() => readLoopAnalysisJob(paths.jobPath)).toThrow(/unknown or missing fields/i);
  });

  describe.each([
    { output: 'file', publication: false },
    { output: 'pr-comment', publication: false },
    { output: 'pr-comment', publication: true },
  ] as const)('$output job with publication=$publication', ({ output, publication }) => {
    it.each(['', '  ', 'cost', undefined])('preserves assignment %j through private storage and restoration', (runtimeAssignment) => {
      const paths = createPaths();
      const job: LoopAnalysisJob = {
        version: 1,
        projectCwd: paths.projectCwd,
        sourceRunDirectory: paths.sourceRunDirectory,
        output,
        parentPid: 4321,
        ...(runtimeAssignment === undefined ? {} : { runtimeAssignment }),
        ...(publication ? {
          branch: 'takt/source-run', publicationMarkerPath: paths.publicationMarkerPath,
        } : {}),
      };

      writeLoopAnalysisJob(paths.jobPath, job);

      const restored = readLoopAnalysisJob(paths.jobPath);
      expect(restored).toEqual(job);
      expect(Object.hasOwn(restored, 'runtimeAssignment'))
        .toBe(runtimeAssignment !== undefined);
      if (process.platform !== 'win32') {
        expect(statSync(paths.jobPath).mode & 0o777).toBe(0o600);
      }
    });

    it.each([1, null])('rejects non-string assignment %j when restoring persisted JSON', (runtimeAssignment) => {
      const paths = createPaths();
      const job = {
        version: 1,
        projectCwd: paths.projectCwd,
        sourceRunDirectory: paths.sourceRunDirectory,
        output,
        parentPid: 4321,
        runtimeAssignment,
        ...(publication ? {
          branch: 'takt/source-run', publicationMarkerPath: paths.publicationMarkerPath,
        } : {}),
      };
      writeFileSync(paths.jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600 });

      expect(() => readLoopAnalysisJob(paths.jobPath)).toThrow(/runtimeAssignment/i);
    });
  });

  it('preserves an absolute runtime file path through private job storage and restoration', () => {
    const paths = createPaths();
    const job: LoopAnalysisJob = {
      version: 1,
      projectCwd: paths.projectCwd,
      sourceRunDirectory: paths.sourceRunDirectory,
      output: 'file',
      parentPid: 4321,
      runtimeFilePath: '/config/runtime.cost.yaml',
    };

    writeLoopAnalysisJob(paths.jobPath, job);

    expect(readLoopAnalysisJob(paths.jobPath)).toEqual(job);
  });

  it('Given a publication marker, When it moves from pending to settled, Then only the current versioned state is restored', () => {
    const paths = createPaths();

    writeLoopAnalysisPublicationMarker(paths.publicationMarkerPath, 'pending');
    expect(readLoopAnalysisPublicationMarker(paths.publicationMarkerPath)).toBe('pending');

    writeLoopAnalysisPublicationMarker(paths.publicationMarkerPath, 'settled');
    expect(readLoopAnalysisPublicationMarker(paths.publicationMarkerPath)).toBe('settled');
  });
});
