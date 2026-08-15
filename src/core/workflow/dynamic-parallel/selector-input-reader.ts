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
    resumeReportConsumerKey?: string,
  ): Promise<SelectorInputs> {
    signal?.throwIfAborted();
    const budget = new SelectorInputBudget();
    const boundedTargetAgentPrompt = targetAgentPrompt === undefined
      ? undefined
      : this.readTargetAgentPrompt(targetAgentPrompt, budget);
    const reports = this.readReports(reportDirectory, requestedNames, budget, signal, resumeReportConsumerKey);
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
    budget: SelectorInputBudget,
    signal: AbortSignal | undefined,
    resumeReportConsumerKey: string | undefined,
  ): string {
    signal?.throwIfAborted();
    if (!existsSync(reportDirectory) && resumeReportConsumerKey === undefined) {
      return this.consumeEmptyValue('(no reports available)', budget);
    }
    const reports = this.resolveExistingReportNames(
      reportDirectory,
      requestedNames,
      resumeReportConsumerKey,
    ).flatMap((candidate, index) => {
      signal?.throwIfAborted();
      const reportPath = candidate.absolutePath;
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

  private resolveExistingReportNames(
    reportDirectory: string,
    requestedNames: readonly string[],
    resumeReportConsumerKey: string | undefined,
  ): readonly SelectorReportCandidate[] {
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
    const currentCandidates = requestedPaths.map((requestedPath): SelectorReportCandidate | undefined => {
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
    const runInfo = this.deriveRunInfoFromReportDir(reportDirectory);
    const manifest = runInfo === undefined || resumeReportConsumerKey === undefined
      ? undefined
      : readResumeReportSnapshotManifest(runInfo.cwd, runInfo.runSlug);
    const consumer = manifest?.resumeReportConsumers
      ?.find((entry) => entry.consumerKey === resumeReportConsumerKey);
    const reportsRoot = runInfo === undefined
      ? undefined
      : buildRunPaths(runInfo.cwd, runInfo.runSlug).reportsRootAbs;
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
          return {
            absolutePath: join(reportsRoot, snapshotPath.path),
            displayPath: snapshotPath.path,
          };
        }
      }
      return undefined;
    }).filter((candidate): candidate is SelectorReportCandidate => candidate !== undefined);
    return [...new Map(resolved.map((candidate) => [candidate.absolutePath, candidate])).values()];
  }

  private deriveRunInfoFromReportDir(reportDir: string): { cwd: string; runSlug: string } | undefined {
    const marker = `${sep}.takt${sep}runs${sep}`;
    const markerIndex = reportDir.lastIndexOf(marker);
    if (markerIndex < 0) return undefined;
    const cwd = reportDir.slice(0, markerIndex);
    const runSlug = reportDir.slice(markerIndex + marker.length).split(sep)[0];
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
