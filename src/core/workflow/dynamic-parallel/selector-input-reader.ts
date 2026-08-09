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
import {
  type SelectorGitCommandRunner,
} from './selector-git-command-runner.js';

const MAX_SELECTOR_ENTRY_BYTES = 64 * 1024;
const MAX_SELECTOR_CHANGED_PATHS = 1_024;
const MAX_SELECTOR_INPUT_BYTES = 1024 * 1024;
const MAX_SELECTOR_GIT_CONCURRENCY = 8;
const MAX_SELECTOR_PATH_LIST_BYTES = 1024 * 1024;
const TAKT_RUN_PATH_PREFIX = '.takt/runs/';

export interface SelectorInputs {
  readonly reports: string;
  readonly workingTreeDiff: string;
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
  ): Promise<SelectorInputs> {
    signal?.throwIfAborted();
    const budget = new SelectorInputBudget();
    const reports = this.readReports(reportDirectory, requestedNames, budget, signal);
    signal?.throwIfAborted();
    const workingTreeDiff = await this.readWorkingTreeDiff(cwd, budget, signal);
    signal?.throwIfAborted();
    return { reports, workingTreeDiff };
  }

  private async readWorkingTreeDiff(
    cwd: string,
    budget: SelectorInputBudget,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    signal?.throwIfAborted();
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
  ): string {
    signal?.throwIfAborted();
    if (!existsSync(reportDirectory)) {
      return this.consumeEmptyValue('(no reports available)', budget);
    }
    const reports = this.resolveExistingReportNames(reportDirectory, requestedNames).map((relativePath, index) => {
      signal?.throwIfAborted();
      const reportPath = join(reportDirectory, relativePath);
      const stat = lstatSync(reportPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Selector report is not a regular file: ${relativePath}`);
      }
      const content = this.readTextFileWithinLimit(
        reportPath,
        MAX_SELECTOR_ENTRY_BYTES,
        `Selector report "${relativePath}"`,
      );
      const report = this.renderEntry(
        relativePath,
        stat.size,
        content,
      );
      budget.consume(index === 0 ? report : `\n\n${report}`);
      return report;
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
    if (result.bytes > MAX_SELECTOR_ENTRY_BYTES) {
      throw new Error(`Dynamic selector path payload "${path}" exceeds ${MAX_SELECTOR_ENTRY_BYTES} bytes`);
    }
    return this.renderEntry(
      path,
      result.bytes,
      this.decodeUtf8(result.output, `Dynamic selector path payload "${path}"`),
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
      mode = (stat.mode & 0o111) === 0 ? '100644' : '100755';
    } else {
      throw new Error(`Selector input is not a regular file: ${path}`);
    }
    const header = `diff --git a/${path} b/${path}\nnew file mode ${mode}\n--- /dev/null\n+++ b/${path}\n`;
    if (mode === '120000') {
      const content = `${header}Symbolic link target: ${readlinkSync(absolutePath)}`;
      if (Buffer.byteLength(content, 'utf-8') > MAX_SELECTOR_ENTRY_BYTES) {
        throw new Error(`Dynamic selector path payload "${path}" exceeds ${MAX_SELECTOR_ENTRY_BYTES} bytes`);
      }
      return this.renderEntry(path, Buffer.byteLength(content), content);
    }
    const available = Math.max(0, MAX_SELECTOR_ENTRY_BYTES - Buffer.byteLength(header));
    const content = this.readTextFileWithinLimit(
      absolutePath,
      available,
      `Dynamic selector path payload "${path}"`,
    );
    return this.renderEntry(
      path,
      Buffer.byteLength(header) + stat.size,
      `${header}${content}`,
    );
  }

  private renderEntry(path: string, bytes: number, content: string): string {
    return [
      `## ${path}`,
      `Source bytes: ${bytes}`,
      'Content status: complete',
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
  ): readonly string[] {
    const requestedPaths = [...new Set(requestedNames)].map((name) => name.split('/'));
    const scan = scanReportEntries(reportDirectory);
    if (scan.failure !== undefined) {
      throw new Error(`Unable to scan selector reports: ${scan.failure}`);
    }
    const entries = scan.entries.map((path) => ({
      relativePath: relative(reportDirectory, path).split(sep).join('/'),
      mtimeMs: lstatSync(path).mtimeMs,
    }));
    return [...new Set(requestedPaths.flatMap((requestedPath) => {
      const candidate = entries
        .filter(({ relativePath }) =>
          workflowCallReportRequestPathsMatch(relativePath.split('/'), requestedPath))
        .sort((left, right) =>
          right.mtimeMs - left.mtimeMs
          || left.relativePath.localeCompare(right.relativePath))[0];
      return candidate === undefined ? [] : [candidate.relativePath];
    }))];
  }

  private readTextFileWithinLimit(
    path: string,
    maxBytes: number,
    sourceName: string,
  ): string {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) {
        throw new Error(`Selector input is not a regular file: ${path}`);
      }
      if (stat.size > maxBytes) {
        throw new Error(`${sourceName} exceeds ${MAX_SELECTOR_ENTRY_BYTES} bytes`);
      }
      const content = Buffer.alloc(stat.size);
      const readBytes = readSync(descriptor, content, 0, content.length, 0);
      if (readBytes !== stat.size) {
        throw new Error(`Unable to read complete selector input: ${path}`);
      }
      return this.decodeUtf8(content, sourceName);
    } finally {
      closeSync(descriptor);
    }
  }

  private decodeUtf8(content: Buffer, sourceName: string): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch (error) {
      throw new Error(`${sourceName} is not valid UTF-8`, { cause: error });
    }
  }
}
