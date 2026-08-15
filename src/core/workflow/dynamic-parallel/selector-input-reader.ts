import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { scanReportEntries } from '../report-file-index.js';
import { workflowCallReportRequestPathsMatch } from '../workflow-call-namespace.js';
import { assertPathSegmentsAreSafe, isPathInside, isRealPathInside } from '../../../shared/utils/index.js';
import { readResumeReportSnapshotManifest } from '../run/resume-report-snapshot.js';
import { buildRunPaths } from '../run/run-paths.js';
import {
  type SelectorGitCommandRunner,
} from './selector-git-command-runner.js';

const MAX_SELECTOR_ENTRY_BYTES = 64 * 1024;
const MAX_SELECTOR_CHANGED_PATHS = 1_024;
const MAX_SELECTOR_INPUT_BYTES = 1024 * 1024;
const MAX_SELECTOR_GIT_CONCURRENCY = 8;
const MAX_SELECTOR_PATH_LIST_BYTES = 1024 * 1024;
const TAKT_RUN_PATH_PREFIX = '.takt/runs/';
const SUBWORKFLOWS_NAMESPACE_DIR = 'subworkflows';

type SelectorFileReadMode = 'complete' | 'truncated';

interface SelectorFileRead {
  readonly content: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface SelectorInputs {
  readonly reports: string;
  readonly workingTreeDiff: string;
  readonly targetAgentPrompt?: string;
}

interface SelectorReportCandidate {
  readonly absolutePath: string;
  readonly displayPath: string;
}

class SelectorInputBudget {
  private bytes = 0;

  consume(value: string): void {
    const next = this.bytes + Buffer.byteLength(value, 'utf-8');
    if (next > MAX_SELECTOR_INPUT_BYTES) {
      throw new Error(`Dynamic selector input exceeds ${MAX_SELECTOR_INPUT_BYTES} bytes`);
    }
    this.bytes = next;
  }
}

export class SelectorInputReader {
  constructor(private readonly commandRunner: SelectorGitCommandRunner) {}

  async readInputs(
    reportDirectory: string,
    requestedNames: readonly string[],
    cwd: string,
    signal: AbortSignal | undefined,
    targetAgentPrompt?: string,
    resumeReportConsumerKeyOrReportsRoot?: string,
    reportsRootDirectoryOrParentReportNames?: string | readonly string[],
    parentReportNames?: readonly string[],
  ): Promise<SelectorInputs> {
    signal?.throwIfAborted();
    const budget = new SelectorInputBudget();
    const boundedTargetAgentPrompt = targetAgentPrompt === undefined
      ? undefined
      : this.readTargetAgentPrompt(targetAgentPrompt, budget);
    const legacyParentReportNames = Array.isArray(reportsRootDirectoryOrParentReportNames)
      ? reportsRootDirectoryOrParentReportNames as readonly string[]
      : undefined;
    const reportOptions: {
      readonly reportsRootDirectory: string | undefined;
      readonly parentReportNames: readonly string[] | undefined;
      readonly resumeReportConsumerKey: string | undefined;
    } = legacyParentReportNames !== undefined
      ? {
          reportsRootDirectory: resumeReportConsumerKeyOrReportsRoot,
          parentReportNames: legacyParentReportNames,
          resumeReportConsumerKey: undefined,
        }
      : {
          reportsRootDirectory: typeof reportsRootDirectoryOrParentReportNames === 'string'
            ? reportsRootDirectoryOrParentReportNames
            : undefined,
          parentReportNames,
          resumeReportConsumerKey: resumeReportConsumerKeyOrReportsRoot,
        };
    const reports = this.readReports(
      reportDirectory,
      requestedNames,
      cwd,
      budget,
      signal,
      reportOptions.resumeReportConsumerKey,
      reportOptions.reportsRootDirectory,
      reportOptions.parentReportNames,
    );
    signal?.throwIfAborted();
    const workingTreeDiff = await this.readWorkingTreeDiff(cwd, budget, signal);
    signal?.throwIfAborted();
    return {
      reports,
      workingTreeDiff,
      ...(boundedTargetAgentPrompt === undefined
        ? {}
        : { targetAgentPrompt: boundedTargetAgentPrompt }),
    };
  }

  private readTargetAgentPrompt(value: string, budget: SelectorInputBudget): string {
    const sourceBytes = Buffer.byteLength(value, 'utf-8');
    const bounded = this.boundUtf8Content(
      value,
      MAX_SELECTOR_ENTRY_BYTES,
      'Dynamic selector target agent prompt',
    );
    const rendered = [
      `Source bytes: ${sourceBytes}`,
      `Content status: ${bounded.truncated ? 'truncated' : 'complete'}`,
      '',
      bounded.content,
    ].join('\n');
    budget.consume(rendered);
    return rendered;
  }

  private async readWorkingTreeDiff(
    cwd: string,
    budget: SelectorInputBudget,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (await this.commandRunner.isInsideWorkTree?.(cwd, signal) === false) {
      return this.consumeEmptyValue('(no working tree changes)', budget);
    }
    const trackedPaths = (await this.listGitPaths(
      cwd,
      ['diff', '--name-only', '-z', 'HEAD', '--end-of-options', '--', '.'],
      signal,
    )).filter((path) => !path.startsWith(TAKT_RUN_PATH_PREFIX));
    const untrackedPaths = (await this.listGitPaths(
      cwd,
      ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'],
      signal,
    )).filter((path) => !path.startsWith(TAKT_RUN_PATH_PREFIX));
    signal?.throwIfAborted();
    const paths = [...new Set([...trackedPaths, ...untrackedPaths])].sort();
    if (paths.length > MAX_SELECTOR_CHANGED_PATHS) {
      throw new Error(`Dynamic selector changed path count exceeds ${MAX_SELECTOR_CHANGED_PATHS}`);
    }
    const untracked = new Set(untrackedPaths);
    const entries = await this.mapWithConcurrency(paths, signal, async (path, index, workerSignal) => {
      workerSignal.throwIfAborted();
      this.assertPathWithinWorkingDirectory(cwd, path);
      const entry = untracked.has(path)
        ? this.readUntrackedEntry(cwd, path, workerSignal)
        : await this.readTrackedEntry(cwd, path, workerSignal);
      workerSignal.throwIfAborted();
      budget.consume(index === 0 ? entry : `\n\n${entry}`);
      return entry;
    });
    if (entries.length === 0) {
      return this.consumeEmptyValue('(no working tree changes)', budget);
    }
    return entries.join('\n\n');
  }

  private readReports(
    reportDirectory: string,
    requestedNames: readonly string[],
    cwd: string,
    budget: SelectorInputBudget,
    signal: AbortSignal | undefined,
    resumeReportConsumerKey: string | undefined,
    reportsRootDirectory: string | undefined,
    parentReportNames: readonly string[] | undefined,
  ): string {
    signal?.throwIfAborted();
    if (requestedNames.length === 0) {
      return this.consumeEmptyValue('(no reports available)', budget);
    }
    const candidates = this.resolveReportCandidates(
      reportDirectory,
      requestedNames,
      cwd,
      reportsRootDirectory,
      parentReportNames,
      resumeReportConsumerKey,
    );
    const reports = candidates.flatMap((candidate, index) => {
      signal?.throwIfAborted();
      const reportPath = candidate.absolutePath;
      this.assertSafeReportPath(cwd, reportPath, candidate.displayPath);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(reportPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return [];
        }
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Selector report is not a regular file: ${candidate.displayPath}`);
      }
      const file = this.readTextFile(
        reportPath,
        MAX_SELECTOR_ENTRY_BYTES,
        `Selector report "${candidate.displayPath}"`,
        'complete',
      );
      const report = this.renderEntry(
        candidate.displayPath,
        file.bytes,
        file.content,
        'complete',
      );
      budget.consume(index === 0 ? report : `\n\n${report}`);
      return [report];
    });
    if (reports.length === 0) {
      return this.consumeEmptyValue('(no reports available)', budget);
    }
    return reports.join('\n\n');
  }

  private resolveReportCandidates(
    reportDirectory: string,
    requestedNames: readonly string[],
    cwd: string,
    reportsRootDirectory: string | undefined,
    parentReportNames: readonly string[] | undefined,
    resumeReportConsumerKey: string | undefined,
  ): readonly SelectorReportCandidate[] {
    const uniqueNames = [...new Set(requestedNames)];
    const currentDirectory = resolve(reportDirectory);
    const reportDirectories = this.resolveReportDirectories(reportDirectory, reportsRootDirectory, cwd);
    const existingDirectories = reportDirectories.filter((directory) => existsSync(directory));
    const directoryCandidates = new Map<string, readonly (SelectorReportCandidate | undefined)[]>();
    const resolveDirectoryCandidates = (
      directory: string,
    ): readonly (SelectorReportCandidate | undefined)[] => {
      const cached = directoryCandidates.get(directory);
      if (cached !== undefined) {
        return cached;
      }
      const candidates = this.resolveExistingReportCandidates(directory, uniqueNames);
      directoryCandidates.set(directory, candidates);
      return candidates;
    };

    const currentCandidates = resolveDirectoryCandidates(currentDirectory);
    const resolvedCandidates = this.resolveResumeReportCandidates(
      reportDirectory,
      uniqueNames,
      currentCandidates,
      cwd,
      reportsRootDirectory,
      resumeReportConsumerKey,
    );
    const explicitlyParentScoped = new Set(parentReportNames ?? []);
    const candidates: SelectorReportCandidate[] = [];
    for (const [index, requestedName] of uniqueNames.entries()) {
      let candidate = resolvedCandidates[index];
      if (candidate === undefined && explicitlyParentScoped.has(requestedName)) {
        for (const directory of existingDirectories) {
          if (directory === currentDirectory) {
            continue;
          }
          candidate = resolveDirectoryCandidates(directory)[index];
          if (candidate !== undefined) {
            break;
          }
        }
      }
      if (candidate !== undefined) {
        candidates.push(candidate);
      }
    }
    return [...new Map(candidates.map((candidate) => [candidate.absolutePath, candidate])).values()];
  }

  private resolveReportDirectories(
    reportDirectory: string,
    reportsRootDirectory: string | undefined,
    cwd: string,
  ): readonly string[] {
    const currentDirectory = resolve(reportDirectory);
    this.assertSafeReportDirectory(cwd, currentDirectory);
    if (reportsRootDirectory === undefined) {
      return [currentDirectory];
    }
    const rootDirectory = resolve(reportsRootDirectory);
    this.assertSafeReportDirectory(cwd, rootDirectory);
    if (!isPathInside(rootDirectory, currentDirectory)
      || !isRealPathInside(rootDirectory, currentDirectory)) {
      throw new Error(`Selector report directory is outside the report root: ${currentDirectory}`);
    }
    const components = relative(rootDirectory, currentDirectory)
      .split(sep)
      .filter((component) => component.length > 0);
    if (
      components.length === 0
      || components.length % 2 !== 0
      || components.some((component, index) => (
        index % 2 === 0 && component !== SUBWORKFLOWS_NAMESPACE_DIR
      ))
    ) {
      return [currentDirectory];
    }
    const directories = [currentDirectory];
    for (let length = components.length - 2; length >= 0; length -= 2) {
      directories.push(resolve(rootDirectory, ...components.slice(0, length)));
    }
    return directories;
  }

  private assertSafeReportDirectory(cwd: string, directory: string): void {
    assertPathSegmentsAreSafe(
      cwd,
      directory,
      (_violation, segmentPath) => new Error(
        `Selector report directory must stay inside the working directory and must not contain symlinks: ${segmentPath}`,
      ),
    );
    if (!isRealPathInside(cwd, directory)) {
      throw new Error(`Selector report directory resolves outside the working directory: ${directory}`);
    }
  }

  private assertSafeReportPath(cwd: string, path: string, displayPath: string): void {
    assertPathSegmentsAreSafe(
      cwd,
      path,
      (_violation, segmentPath) => new Error(
        `Selector report "${displayPath}" must stay inside the working directory and must not contain symlinks: ${segmentPath}`,
      ),
    );
    if (!isRealPathInside(cwd, path)) {
      throw new Error(`Selector report "${displayPath}" resolves outside the working directory: ${path}`);
    }
  }

  private consumeEmptyValue(value: string, budget: SelectorInputBudget): string {
    budget.consume(value);
    return value;
  }

  private async readTrackedEntry(
    cwd: string,
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const result = await this.commandRunner.run(
      cwd,
      ['diff', 'HEAD', '--end-of-options', '--', path],
      MAX_SELECTOR_ENTRY_BYTES,
      signal,
    );
    const truncated = result.bytes > MAX_SELECTOR_ENTRY_BYTES;
    return this.renderEntry(
      path,
      result.bytes,
      this.decodeUtf8(
        result.output,
        `Dynamic selector path payload "${path}"`,
        truncated,
      ),
      truncated ? 'truncated' : 'complete',
    );
  }

  private readUntrackedEntry(cwd: string, path: string, signal: AbortSignal | undefined): string {
    signal?.throwIfAborted();
    const absolutePath = join(cwd, path);
    const stat = lstatSync(absolutePath);
    let mode: '100644' | '100755' | '120000';
    if (stat.isSymbolicLink()) {
      mode = '120000';
    } else if (stat.isFile()) {
      mode = (stat.mode & 0o100) === 0 ? '100644' : '100755';
    } else {
      throw new Error(`Selector input is not a regular file: ${path}`);
    }
    const header = `diff --git a/${path} b/${path}\nnew file mode ${mode}\n--- /dev/null\n+++ b/${path}\n`;
    if (mode === '120000') {
      const content = `${header}Symbolic link target: ${readlinkSync(absolutePath)}`;
      const sourceBytes = Buffer.byteLength(content, 'utf-8');
      const bounded = this.boundUtf8Content(
        content,
        MAX_SELECTOR_ENTRY_BYTES,
        `Dynamic selector path payload "${path}"`,
      );
      return this.renderEntry(
        path,
        sourceBytes,
        bounded.content,
        bounded.truncated ? 'truncated' : 'complete',
      );
    }
    const headerBytes = Buffer.byteLength(header, 'utf-8');
    const available = Math.max(0, MAX_SELECTOR_ENTRY_BYTES - headerBytes);
    const file = this.readTextFile(
      absolutePath,
      available,
      `Dynamic selector path payload "${path}"`,
      'truncated',
    );
    const sourceBytes = headerBytes + file.bytes;
    const bounded = this.boundUtf8Content(
      `${header}${file.content}`,
      MAX_SELECTOR_ENTRY_BYTES,
      `Dynamic selector path payload "${path}"`,
    );
    return this.renderEntry(
      path,
      sourceBytes,
      bounded.content,
      file.truncated || bounded.truncated ? 'truncated' : 'complete',
    );
  }

  private renderEntry(
    path: string,
    bytes: number,
    content: string,
    status: 'complete' | 'truncated',
  ): string {
    return [
      `## ${path}`,
      `Source bytes: ${bytes}`,
      `Content status: ${status}`,
      '',
      content,
    ].join('\n');
  }

  private async listGitPaths(
    cwd: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<string[]> {
    const result = await this.commandRunner.run(
      cwd,
      args,
      MAX_SELECTOR_PATH_LIST_BYTES,
      signal,
    );
    signal?.throwIfAborted();
    if (result.bytes > MAX_SELECTOR_PATH_LIST_BYTES) {
      throw new Error(`Dynamic selector Git path list exceeds ${MAX_SELECTOR_PATH_LIST_BYTES} bytes`);
    }
    return result.output.toString('utf-8').split('\0').filter((path) => path !== '');
  }

  private assertPathWithinWorkingDirectory(cwd: string, path: string): void {
    const relativeToCwd = relative(resolve(cwd), resolve(cwd, path));
    if (
      path === ''
      || isAbsolute(path)
      || relativeToCwd === '..'
      || relativeToCwd.startsWith(`..${sep}`)
      || isAbsolute(relativeToCwd)
    ) {
      throw new Error(`Selector Git path is outside the working directory: ${path}`);
    }
  }

  private async mapWithConcurrency<T>(
    values: readonly string[],
    signal: AbortSignal | undefined,
    worker: (value: string, index: number, signal: AbortSignal) => Promise<T>,
  ): Promise<T[]> {
    const results = new Array<T>(values.length);
    const controller = new AbortController();
    const workerSignal = signal === undefined
      ? controller.signal
      : AbortSignal.any([signal, controller.signal]);
    let firstError: unknown;
    let nextIndex = 0;
    const runWorker = async (): Promise<void> => {
      while (firstError === undefined && nextIndex < values.length) {
        workerSignal.throwIfAborted();
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await worker(values[index]!, index, workerSignal);
        } catch (error) {
          if (firstError === undefined) {
            firstError = error;
            controller.abort(error);
          }
        }
      }
    };
    await Promise.allSettled(
      Array.from(
        { length: Math.min(values.length, MAX_SELECTOR_GIT_CONCURRENCY) },
        () => runWorker(),
      ),
    );
    if (firstError !== undefined) {
      throw firstError;
    }
    workerSignal.throwIfAborted();
    return results;
  }

  private resolveExistingReportCandidates(
    reportDirectory: string,
    requestedNames: readonly string[],
  ): readonly (SelectorReportCandidate | undefined)[] {
    const requestedPaths = [...new Set(requestedNames)].map((name) => name.split('/'));
    const scan = existsSync(reportDirectory)
      ? scanReportEntries(reportDirectory)
      : { entries: [] };
    if (scan.failure !== undefined) {
      if (existsSync(reportDirectory)) {
        throw new Error(`Unable to scan selector reports: ${scan.failure}`);
      }
    }
    const entries = (scan.failure === undefined ? scan.entries : []).map((path) => ({
      relativePath: relative(reportDirectory, path).split(sep).join('/'),
      mtimeMs: lstatSync(path).mtimeMs,
    }));
    return requestedPaths.map((requestedPath): SelectorReportCandidate | undefined => {
      const candidate = entries
        .filter(({ relativePath }) =>
          workflowCallReportRequestPathsMatch(relativePath.split('/'), requestedPath))
        .sort((left, right) =>
          right.mtimeMs - left.mtimeMs
          || left.relativePath.localeCompare(right.relativePath))[0];
      return candidate === undefined ? undefined : {
        absolutePath: join(reportDirectory, candidate.relativePath),
        displayPath: candidate.relativePath,
      };
    });
  }

  private resolveResumeReportCandidates(
    reportDirectory: string,
    requestedNames: readonly string[],
    currentCandidates: readonly (SelectorReportCandidate | undefined)[],
    cwd: string,
    reportsRootDirectory: string | undefined,
    resumeReportConsumerKey: string | undefined,
  ): readonly (SelectorReportCandidate | undefined)[] {
    if (resumeReportConsumerKey === undefined) {
      return currentCandidates;
    }
    const requestedPaths = [...new Set(requestedNames)].map((name) => name.split('/'));
    const runInfo = this.deriveRunInfoFromReportDir(reportDirectory);
    const manifest = runInfo === undefined || resumeReportConsumerKey === undefined
      ? undefined
      : readResumeReportSnapshotManifest(runInfo.cwd, runInfo.runSlug);
    const consumer = manifest?.resumeReportConsumers
      ?.find((entry) => entry.consumerKey === resumeReportConsumerKey);
    const reportsRoot = runInfo === undefined
      ? undefined
      : reportsRootDirectory === undefined
        ? buildRunPaths(runInfo.cwd, runInfo.runSlug).reportsRootAbs
        : resolve(reportsRootDirectory);
    if (reportsRoot !== undefined) {
      this.assertSafeReportDirectory(cwd, reportsRoot);
    }
    const resolved = currentCandidates.map((candidate, index): SelectorReportCandidate | undefined => {
      if (candidate !== undefined || consumer === undefined || reportsRoot === undefined) {
        return candidate;
      }
      const requestedPath = requestedPaths[index]!;
      for (const directory of consumer.reportDirectories) {
        const prefix = directory.length === 0 ? '' : `${directory}/`;
        const snapshotPath = manifest?.files
          .map((file) => file.path)
          .filter((path) => path.startsWith(prefix))
          .map((path) => ({ path, relativePath: path.slice(prefix.length) }))
          .filter(({ relativePath }) =>
            workflowCallReportRequestPathsMatch(relativePath.split('/'), requestedPath))
          .sort((left, right) => left.path.localeCompare(right.path))[0];
        if (snapshotPath !== undefined) {
          const absolutePath = resolve(reportsRoot, snapshotPath.path);
          if (!isPathInside(reportsRoot, absolutePath) || !isRealPathInside(reportsRoot, absolutePath)) {
            throw new Error(`Selector report snapshot path is outside the report root: ${snapshotPath.path}`);
          }
          this.assertSafeReportPath(cwd, absolutePath, snapshotPath.path);
          return {
            absolutePath,
            displayPath: snapshotPath.path,
          };
        }
      }
      return undefined;
    });
    return resolved;
  }

  private deriveRunInfoFromReportDir(reportDir: string): { cwd: string; runSlug: string } | undefined {
    const absoluteReportDir = resolve(reportDir);
    const marker = `${sep}.takt${sep}runs${sep}`;
    const markerIndex = absoluteReportDir.lastIndexOf(marker);
    if (markerIndex < 0) return undefined;
    const cwd = absoluteReportDir.slice(0, markerIndex);
    const runSlug = absoluteReportDir.slice(markerIndex + marker.length).split(sep)[0];
    return runSlug ? { cwd, runSlug } : undefined;
  }

  private readTextFile(
    path: string,
    maxBytes: number,
    sourceName: string,
    mode: SelectorFileReadMode,
  ): SelectorFileRead {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) {
        throw new Error(`Selector input is not a regular file: ${path}`);
      }
      const truncated = mode === 'truncated' && stat.size > maxBytes;
      if (mode === 'complete' && stat.size > maxBytes) {
        throw new Error(`${sourceName} exceeds ${MAX_SELECTOR_ENTRY_BYTES} bytes`);
      }
      const bytesToRead = truncated ? maxBytes : stat.size;
      const content = Buffer.alloc(bytesToRead);
      const readBytes = readSync(descriptor, content, 0, content.length, 0);
      if (readBytes !== bytesToRead) {
        throw new Error(`Unable to read complete selector input: ${path}`);
      }
      return {
        content: this.decodeUtf8(content, sourceName, truncated),
        bytes: stat.size,
        truncated,
      };
    } finally {
      closeSync(descriptor);
    }
  }

  private boundUtf8Content(
    content: string,
    maxBytes: number,
    sourceName: string,
  ): { readonly content: string; readonly truncated: boolean } {
    const bytes = Buffer.from(content, 'utf-8');
    if (bytes.length <= maxBytes) {
      return { content, truncated: false };
    }
    return {
      content: this.decodeUtf8(bytes.subarray(0, maxBytes), sourceName, true),
      truncated: true,
    };
  }

  private decodeUtf8(content: Buffer, sourceName: string, truncated: boolean): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(content, { stream: truncated });
    } catch (error) {
      throw new Error(`${sourceName} is not valid UTF-8`, { cause: error });
    }
  }
}
