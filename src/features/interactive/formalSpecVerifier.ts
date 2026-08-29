import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep, resolve } from 'node:path';
import { spawnManagedProcess } from '../../shared/utils/spawn.js';

const require = createRequire(import.meta.url);

const QUINT_TIMEOUT_MS = 60_000;
const ALLOY_TIMEOUT_MS = 60_000;
const ALLOY_VERSION = '6.2.0';
const ALLOY_JAR_URL = `https://repo1.maven.org/maven2/org/alloytools/org.alloytools.alloy.dist/${ALLOY_VERSION}/org.alloytools.alloy.dist-${ALLOY_VERSION}.jar`;
const ALLOY_JAR_SHA256 = '6037cbeee0e8423c1c468447ed10f5fcf2f2743a2ffc39cb1c81f2905c0fdb9d';
const MAX_PROCESS_OUTPUT = 1024 * 1024;
const ALLOY_COMMAND_OUTPUT_TRUNCATED_MESSAGE = 'Alloy command enumeration output was truncated before all commands could be read.';
const MAX_FAILURE_MESSAGE = 8_000;
const VERIFY_RUN_METADATA_FILE = '.verify-run.json';
const VERIFY_RUN_METADATA_VERSION = 1;
const VERIFY_RUN_STAGING_PREFIX = '.verify-staging-';

export type FormalSpecVerificationStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface FormalSpecStageResult {
  readonly status: FormalSpecVerificationStatus;
  readonly message?: string;
  readonly checks?: readonly number[];
}

export interface FormalSpecQuintResult extends FormalSpecStageResult {
  readonly parse?: FormalSpecStageResult;
  readonly typecheck?: FormalSpecStageResult;
  readonly run?: FormalSpecStageResult;
  readonly verify?: FormalSpecStageResult;
  readonly invariants?: readonly string[];
  readonly temporal?: readonly string[];
}

export interface FormalSpecAlloyResult extends FormalSpecStageResult {
  readonly commands?: readonly AlloyParsedCommand[];
}

export interface FormalSpecVerificationResult {
  readonly verdict: 'passed' | 'failed' | 'error';
  readonly verificationStarted: boolean;
  readonly message?: string;
  readonly javaMajorVersion?: number;
  readonly quint: FormalSpecQuintResult;
  readonly alloy: FormalSpecAlloyResult;
}

export interface FormalSpecBlocks {
  readonly quint: readonly string[];
  readonly alloy: readonly string[];
}

export interface QuintVerificationTargets {
  readonly invariants: readonly QuintVerificationTarget[];
  readonly temporal: readonly QuintVerificationTarget[];
}

export interface QuintVerificationTarget {
  readonly moduleName: string;
  readonly name: string;
}

export interface AlloyParsedCommand {
  readonly number: number;
  readonly type: string;
  readonly label: string;
}

type ProcessOutcome = 'exit' | 'spawn_error' | 'timeout' | 'signal';

interface ProcessResult {
  readonly outcome: ProcessOutcome;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly error?: string;
}

interface FenceState {
  readonly character: '`' | '~';
  readonly length: number;
  readonly target?: 'quint' | 'alloy';
  readonly content: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseFenceLine(line: string): { character: '`' | '~'; length: number; info: string } | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match) {
    return undefined;
  }

  const marker = match[2];
  if (!marker) {
    return undefined;
  }
  const character = marker[0];
  if (character !== '`' && character !== '~') {
    return undefined;
  }
  return {
    character,
    length: marker.length,
    info: (match[3] ?? '').trim(),
  };
}

/** Extract only closed Quint and Alloy fences from one provider response. */
export function extractFormalSpecBlocks(response: string): FormalSpecBlocks {
  const blocks: { quint: string[]; alloy: string[] } = { quint: [], alloy: [] };
  let fence: FenceState | undefined;

  for (const line of response.split(/\r\n?|\n/u)) {
    const parsedFence = parseFenceLine(line);

    if (fence) {
      const closesFence = parsedFence !== undefined
        && parsedFence.character === fence.character
        && parsedFence.length >= fence.length
        && parsedFence.info === '';
      if (closesFence) {
        if (fence.target) {
          blocks[fence.target].push(fence.content.join('\n').trim());
        }
        fence = undefined;
      } else if (fence.target) {
        fence.content.push(line);
      }
      continue;
    }

    if (!parsedFence) {
      continue;
    }

    const normalizedInfo = parsedFence.info.toLowerCase();
    const target = normalizedInfo === 'quint' || normalizedInfo === 'alloy'
      ? normalizedInfo
      : undefined;
    fence = {
      character: parsedFence.character,
      length: parsedFence.length,
      ...(target ? { target } : {}),
      content: [],
    };
  }

  if (fence?.target) {
    throw new Error(`Unclosed ${fence.target} code fence`);
  }

  return blocks;
}

/** Parse the Java version strings emitted by common JDK distributions. */
export function detectJavaMajorVersion(output: string): number | undefined {
  const versionMatch = /\bversion\s+["']?(\d+)(?:\.(\d+))?/iu.exec(output);
  const directMatch = /\b(?:openjdk|java)\s+["']?(\d+)(?:\.(\d+))?/iu.exec(output);
  const match = versionMatch ?? directMatch;
  if (!match) {
    return undefined;
  }

  const first = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isInteger(first)) {
    return undefined;
  }
  if (first === 1) {
    const legacyMinor = Number.parseInt(match[2] ?? '', 10);
    return Number.isInteger(legacyMinor) ? legacyMinor : undefined;
  }
  return first;
}

/** Select every conventionally named Quint invariant and temporal property. */
export function selectQuintVerificationTargets(parseResult: unknown): QuintVerificationTargets {
  const invariants: QuintVerificationTarget[] = [];
  const temporal: QuintVerificationTarget[] = [];
  if (!isRecord(parseResult) || !Array.isArray(parseResult.modules)) {
    return { invariants, temporal };
  }

  for (const module of parseResult.modules) {
    if (!isRecord(module) || typeof module.name !== 'string' || !Array.isArray(module.declarations)) {
      continue;
    }
    for (const declaration of module.declarations) {
      if (!isRecord(declaration) || declaration.kind !== 'def' || typeof declaration.name !== 'string') {
        continue;
      }
      if (declaration.qualifier === 'val' && declaration.name.startsWith('inv')) {
        invariants.push({ moduleName: module.name, name: declaration.name });
      }
      if (declaration.qualifier === 'temporal' && declaration.name.startsWith('prop')) {
        temporal.push({ moduleName: module.name, name: declaration.name });
      }
    }
  }

  return { invariants, temporal };
}

const QUINT_MAIN_REQUIRED_MESSAGE = 'Quint verification requires a module with action init and action step.';

function formatQuintTarget(target: QuintVerificationTarget): string {
  return `${target.moduleName}::${target.name}`;
}

function quintTargetsOutsideMainModule(
  targets: QuintVerificationTargets,
  mainModule: string,
): QuintVerificationTarget[] {
  return [...targets.invariants, ...targets.temporal]
    .filter((target) => target.moduleName !== mainModule);
}

function quintTargetScopeError(
  targets: QuintVerificationTargets,
  mainModule: string,
): string | undefined {
  const outOfScopeTargets = quintTargetsOutsideMainModule(targets, mainModule);
  if (outOfScopeTargets.length === 0) {
    return undefined;
  }
  return `Quint verification targets must be declared in the main module ${mainModule}: ${outOfScopeTargets.map(formatQuintTarget).join(', ')}.`;
}

function selectQuintMainModule(parseResult: unknown): string | undefined {
  if (!isRecord(parseResult) || !Array.isArray(parseResult.modules)) {
    return undefined;
  }

  for (const module of parseResult.modules) {
    if (!isRecord(module) || typeof module.name !== 'string' || !Array.isArray(module.declarations)) {
      continue;
    }

    const actionNames = new Set(
      module.declarations
        .filter((declaration): declaration is Record<string, unknown> => (
          isRecord(declaration)
          && declaration.kind === 'def'
          && declaration.qualifier === 'action'
          && typeof declaration.name === 'string'
        ))
        .map((declaration) => declaration.name),
    );
    if (actionNames.has('init') && actionNames.has('step')) {
      return module.name;
    }
  }

  return undefined;
}

/** Return all parsed Alloy checks, including repeated command numbers. */
export function selectAlloyCheckTargets(commands: readonly AlloyParsedCommand[]): readonly number[] {
  return commands
    .filter((command) => command.type === 'check')
    .map((command) => command.number);
}

function toProcessText(value: string | Buffer | null): string {
  return value === null ? '' : String(value);
}

function appendProcessOutput(current: string, chunk: string): { output: string; truncated: boolean } {
  const remaining = MAX_PROCESS_OUTPUT - current.length;
  return {
    output: remaining > 0 ? current + chunk.slice(0, remaining) : current,
    truncated: chunk.length > Math.max(remaining, 0),
  };
}

async function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeout: number,
  abortSignal?: AbortSignal,
  runtimeState?: VerifyRunRuntimeState,
): Promise<ProcessResult> {
  abortSignal?.throwIfAborted();
  const processAbortController = new AbortController();
  let timedOut = false;
  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    processAbortController.abort(new Error(`Process timed out after ${timeout} ms`));
  }, timeout);
  const onAbort = (): void => {
    processAbortController.abort(abortSignal?.reason);
  };
  abortSignal?.addEventListener('abort', onAbort, { once: true });
  let childPid: number | undefined;
  let launchId: string | undefined;

  try {
    if (!beginVerifyRunLaunch(cwd)) {
      throw new Error('Could not record the formal verification subprocess launch state.');
    }
    let managedProcess: ReturnType<typeof spawnManagedProcess>;
    try {
      managedProcess = spawnManagedProcess(
        command,
        args,
        {
          cwd,
          env: {
            ...process.env,
            TMPDIR: cwd,
            TMP: cwd,
            TEMP: cwd,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
        processAbortController.signal,
      );
    } catch (error) {
      finishVerifyRunLaunch(cwd);
      throw error;
    }
    childPid = managedProcess.child.pid;
    launchId = childPid === undefined ? undefined : randomUUID();
    if (childPid === undefined || launchId === undefined || !finishVerifyRunLaunch(cwd, childPid, launchId)) {
      let terminated = false;
      try {
        await managedProcess.terminate();
        terminated = true;
      } catch {
        // The launch marker remains conservative if termination also fails.
      }
      const childProcessGone = childPid === undefined || isVerifyRunProcessTreeGone(childPid);
      if (terminated && childProcessGone) {
        finishVerifyRunLaunch(cwd);
      }
      throw new Error('Could not record the formal verification subprocess.');
    }
    managedProcess.child.stdout?.setEncoding('utf8');
    managedProcess.child.stdout?.on('data', (chunk: string | Buffer) => {
      const appended = appendProcessOutput(stdout, toProcessText(chunk));
      stdout = appended.output;
      stdoutTruncated ||= appended.truncated;
    });
    managedProcess.child.stderr?.setEncoding('utf8');
    managedProcess.child.stderr?.on('data', (chunk: string | Buffer) => {
      const appended = appendProcessOutput(stderr, toProcessText(chunk));
      stderr = appended.output;
      stderrTruncated ||= appended.truncated;
    });

    const exit = await managedProcess.wait();
    if (launchId !== undefined) {
      runtimeState?.completedProcessIds.add(launchId);
    }
    abortSignal?.throwIfAborted();
    if (timedOut) {
      return {
        outcome: 'timeout',
        status: null,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        error: `Process timed out after ${timeout} ms`,
      };
    }
    return {
      outcome: exit.signal === null ? 'exit' : 'signal',
      status: exit.code,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
    };
  } catch (error) {
    abortSignal?.throwIfAborted();
    if (timedOut) {
      return {
        outcome: 'timeout',
        status: null,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        error: `Process timed out after ${timeout} ms`,
      };
    }
    return {
      outcome: 'spawn_error',
      status: null,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeoutHandle);
    abortSignal?.removeEventListener('abort', onAbort);
  }
}

function processFailureMessage(result: ProcessResult): string {
  const details = [result.error, result.stderr.trim(), result.stdout.trim()]
    .filter((detail): detail is string => detail !== undefined && detail.length > 0)
    .join('\n');
  const exitStatus = result.status === null ? 'unknown' : String(result.status);
  const defaultMessage = result.outcome === 'signal'
    ? 'Process was terminated by a signal.'
    : result.outcome === 'timeout'
      ? 'Process timed out.'
      : `Process exited with status ${exitStatus}`;
  const message = details || defaultMessage;
  return message.length > MAX_FAILURE_MESSAGE
    ? `${message.slice(0, MAX_FAILURE_MESSAGE)}\n[output truncated]`
    : message;
}

function passedStage(): FormalSpecStageResult {
  return { status: 'passed' };
}

function skippedStage(message: string): FormalSpecStageResult {
  return { status: 'skipped', message };
}

function failedStage(result: ProcessResult): FormalSpecStageResult {
  return { status: 'failed', message: processFailureMessage(result) };
}

function errorStage(message: string): FormalSpecStageResult {
  return { status: 'error', message };
}

function isSuccessfulProcess(result: ProcessResult): boolean {
  return result.outcome === 'exit' && result.status === 0;
}

function specificationProcessStage(result: ProcessResult): FormalSpecStageResult {
  return isSuccessfulProcess(result)
    ? passedStage()
    : errorStage(processFailureMessage(result));
}

function verificationProcessStage(result: ProcessResult): FormalSpecStageResult {
  if (isSuccessfulProcess(result)) {
    return passedStage();
  }
  return result.outcome === 'exit' && result.status !== null
    ? failedStage(result)
    : errorStage(processFailureMessage(result));
}

function selectPrimaryStage(stages: readonly FormalSpecStageResult[]): FormalSpecStageResult {
  return stages.find((stage) => stage.status === 'error')
    ?? stages.find((stage) => stage.status === 'failed')
    ?? stages.find((stage) => stage.status === 'passed')
    ?? stages.find((stage) => stage.status === 'skipped')
    ?? skippedStage('No verification stage was executed.');
}

function aggregateStageResult(
  stages: readonly FormalSpecStageResult[],
  emptyMessage: string,
): FormalSpecStageResult {
  return stages.length > 0 ? selectPrimaryStage(stages) : skippedStage(emptyMessage);
}

interface VerifyRunMetadata {
  readonly version: 1;
  readonly ownerPid: number;
  readonly launchUncertain: boolean;
  readonly processes: readonly VerifyRunProcess[];
}

interface VerifyRunProcess {
  readonly id: string;
  readonly pid: number;
}

interface VerifyRunDirectory {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

interface VerifyRunRuntimeState {
  readonly completedProcessIds: Set<string>;
}

function isPathContained(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}

function readVerifyRunMetadata(directory: string): VerifyRunMetadata | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(directory, VERIFY_RUN_METADATA_FILE), 'utf8'));
    if (!isRecord(value)
      || value.version !== VERIFY_RUN_METADATA_VERSION
      || typeof value.ownerPid !== 'number'
      || !Number.isSafeInteger(value.ownerPid)
      || value.ownerPid <= 0
      || typeof value.launchUncertain !== 'boolean'
      || !Array.isArray(value.processes)
      || !value.processes.every((process): process is Record<string, unknown> => isRecord(process)
        && typeof process.id === 'string'
        && process.id.length > 0
        && typeof process.pid === 'number'
        && Number.isSafeInteger(process.pid)
        && process.pid > 0
      )) {
      return undefined;
    }
    return {
      version: VERIFY_RUN_METADATA_VERSION,
      ownerPid: value.ownerPid,
      launchUncertain: value.launchUncertain,
      processes: value.processes.map((process) => ({
        id: process.id as string,
        pid: process.pid as number,
      })),
    };
  } catch {
    return undefined;
  }
}

function isVerifyRunProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function isVerifyRunProcessGroupGone(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function areVerifyRunGroupsGone(
  processes: readonly VerifyRunProcess[],
  completedProcessIds?: ReadonlySet<string>,
): boolean {
  return processes.every(({ id, pid }) => process.platform === 'win32'
    ? completedProcessIds?.has(id) === true
    : isVerifyRunProcessGroupGone(pid));
}

function isVerifyRunProcessTreeGone(pid: number): boolean {
  return isVerifyRunProcessGone(pid)
    && (process.platform === 'win32' || isVerifyRunProcessGroupGone(pid));
}

function writeVerifyRunMetadata(directory: string, metadata: VerifyRunMetadata): void {
  const temporaryPath = join(directory, `.${VERIFY_RUN_METADATA_FILE}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(metadata)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, join(directory, VERIFY_RUN_METADATA_FILE));
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function updateVerifyRunMetadata(
  directory: string,
  update: (metadata: VerifyRunMetadata) => VerifyRunMetadata,
): boolean {
  const metadata = readVerifyRunMetadata(directory);
  if (metadata === undefined) return false;
  try {
    writeVerifyRunMetadata(directory, update(metadata));
    return true;
  } catch {
    return false;
  }
}

function beginVerifyRunLaunch(directory: string): boolean {
  const metadata = readVerifyRunMetadata(directory);
  return metadata !== undefined && !metadata.launchUncertain
    && updateVerifyRunMetadata(directory, (current) => ({ ...current, launchUncertain: true }));
}

function finishVerifyRunLaunch(directory: string, childPid?: number, launchId?: string): boolean {
  return updateVerifyRunMetadata(directory, (metadata) => ({
    ...metadata,
    launchUncertain: false,
    processes: childPid === undefined || launchId === undefined
      ? metadata.processes
      : [...metadata.processes, { id: launchId, pid: childPid }],
  }));
}

function parseVerifyRunStagingOwnerPid(name: string): number | undefined {
  if (!name.startsWith(VERIFY_RUN_STAGING_PREFIX)) return undefined;
  const match = /^(\d+)-/u.exec(name.slice(VERIFY_RUN_STAGING_PREFIX.length));
  const pid = match ? Number.parseInt(match[1] ?? '', 10) : Number.NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function safeDirectoryComponent(
  path: string,
  parent: string,
  create: boolean,
): VerifyRunDirectory | undefined {
  try {
    if (create) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const stat = lstatSync(path);
    const realPath = realpathSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isPathContained(parent, realPath)) {
      return undefined;
    }
    return { path: realPath, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (create) throw error;
    return undefined;
  }
}

function safeVerifyRunsDirectory(cwd: string, create = false): VerifyRunDirectory | undefined {
  const project = realpathSync(cwd);
  const takt = safeDirectoryComponent(join(cwd, '.takt'), project, create);
  const runs = takt === undefined
    ? undefined
    : safeDirectoryComponent(join(cwd, '.takt', 'runs'), takt.path, create);
  return runs;
}

function sameVerifyRunsDirectory(cwd: string, expected: VerifyRunDirectory): boolean {
  const current = safeVerifyRunsDirectory(cwd);
  return current !== undefined
    && current.path === expected.path && current.dev === expected.dev && current.ino === expected.ino;
}

function safeRunPath(runs: VerifyRunDirectory, directory: string): string | undefined {
  try {
    const stat = lstatSync(directory);
    const realPath = realpathSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink()
      && realPath !== runs.path && isPathContained(runs.path, realPath)
      ? realPath
      : undefined;
  } catch {
    return undefined;
  }
}

/** Remove abandoned published runs and markerless staging directories safely. */
function cleanupAbandonedVerifyRuns(cwd: string): void {
  let runs: VerifyRunDirectory | undefined;
  try {
    runs = safeVerifyRunsDirectory(cwd);
  } catch {
    return;
  }
  if (runs === undefined) return;
  let entries;
  try {
    entries = readdirSync(runs.path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!sameVerifyRunsDirectory(cwd, runs)) return;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = safeRunPath(runs, join(runs.path, entry.name));
    if (directory === undefined) continue;
    const stagingPid = parseVerifyRunStagingOwnerPid(entry.name);
    if (stagingPid !== undefined) {
      if (isVerifyRunProcessGone(stagingPid)) removeVerifyRunDirectory(directory);
      continue;
    }
    if (!entry.name.startsWith('verify-')) continue;
    const metadata = readVerifyRunMetadata(directory);
    if (metadata !== undefined && !metadata.launchUncertain
      && isVerifyRunProcessGone(metadata.ownerPid)
      && areVerifyRunGroupsGone(metadata.processes)) {
      removeVerifyRunDirectory(directory);
    }
  }
}

function removeVerifyRunDirectoryIfSafe(
  cwd: string,
  directory: string,
  runtimeState: VerifyRunRuntimeState,
): void {
  let runs: VerifyRunDirectory | undefined;
  try {
    runs = safeVerifyRunsDirectory(cwd);
  } catch {
    return;
  }
  if (runs === undefined || !sameVerifyRunsDirectory(cwd, runs)) return;
  const realDirectory = safeRunPath(runs, directory);
  if (realDirectory === undefined) return;
  const metadata = readVerifyRunMetadata(realDirectory);
  if (metadata === undefined || metadata.launchUncertain
    || (metadata.ownerPid !== process.pid && !isVerifyRunProcessGone(metadata.ownerPid))
    || !areVerifyRunGroupsGone(metadata.processes, runtimeState.completedProcessIds)) return;
  removeVerifyRunDirectory(realDirectory);
}

function removeVerifyRunDirectory(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort and must not replace the verification result.
  }
}

function createRunDirectory(cwd: string): string {
  const runs = safeVerifyRunsDirectory(cwd, true);
  if (runs === undefined) throw new Error('Formal verification workspace directory is not safe.');
  const stagingPrefix = join(runs.path, `${VERIFY_RUN_STAGING_PREFIX}${process.pid}-`);
  let staging: string | undefined;
  let published: string | undefined;
  try {
    staging = mkdtempSync(stagingPrefix);
    if (!sameVerifyRunsDirectory(cwd, runs) || safeRunPath(runs, staging) === undefined) {
      throw new Error('Formal verification workspace directory changed during creation.');
    }
    writeVerifyRunMetadata(staging, {
      version: VERIFY_RUN_METADATA_VERSION,
      ownerPid: process.pid,
      launchUncertain: false,
      processes: [],
    });
    mkdirSync(join(staging, 'specs'), { mode: 0o700 });
    if (!sameVerifyRunsDirectory(cwd, runs) || safeRunPath(runs, staging) === undefined) {
      throw new Error('Formal verification workspace directory changed during creation.');
    }
    published = join(runs.path, `verify-${process.pid}-${randomUUID()}`);
    renameSync(staging, published);
    staging = undefined;
    if (!sameVerifyRunsDirectory(cwd, runs) || safeRunPath(runs, published) === undefined) {
      throw new Error('Formal verification workspace directory changed during publication.');
    }
    return published;
  } catch (error) {
    if (sameVerifyRunsDirectory(cwd, runs)) {
      for (const candidate of [staging, published]) {
        if (candidate !== undefined) {
          const safeCandidate = safeRunPath(runs, candidate);
          if (safeCandidate !== undefined) removeVerifyRunDirectory(safeCandidate);
        }
      }
    }
    throw error;
  }
}

function writeSpecification(directory: string, name: string, blocks: readonly string[]): string {
  const path = join(directory, 'specs', name);
  writeFileSync(path, `${blocks.join('\n\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

function resolveQuintCli(): string {
  return require.resolve('@informalsystems/quint/dist/src/cli.js') as string;
}

function skippedQuintResult(message: string): FormalSpecQuintResult {
  return { status: 'skipped', message };
}

function skippedAlloyResult(message: string): FormalSpecAlloyResult {
  return { status: 'skipped', message };
}

function resultForNoBlocks(message: string): FormalSpecVerificationResult {
  return {
    verdict: 'error',
    verificationStarted: false,
    message,
    quint: skippedQuintResult(message),
    alloy: skippedAlloyResult(message),
  };
}

function resultForUnexpectedError(
  error: unknown,
  verificationStarted: boolean,
): FormalSpecVerificationResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    verdict: 'error',
    verificationStarted,
    message,
    quint: errorStage(message),
    alloy: skippedAlloyResult('Verification stopped before Alloy could run.'),
  };
}

function parseAlloyCommands(output: string): AlloyParsedCommand[] {
  const commands: AlloyParsedCommand[] = [];
  for (const line of output.split(/\r\n?|\n/u)) {
    const match = /^\s*(\d+)\s+\.\s+(Check|Run)\s+(.+?)\s*$/iu.exec(line);
    if (!match) {
      continue;
    }
    const number = Number.parseInt(match[1] ?? '', 10);
    const type = (match[2] ?? '').toLowerCase();
    const label = (match[3] ?? '').replace(/\s+for\s+.+$/iu, '').trim();
    if (Number.isInteger(number) && label) {
      commands.push({ number, type, label });
    }
  }
  return commands;
}

function isUsableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function assertTrustedAlloyJar(bytes: Buffer, source: string): void {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== ALLOY_JAR_SHA256) {
    throw new Error(`Alloy jar SHA-256 mismatch for ${source}`);
  }
}

async function ensureAlloyJar(cwd: string, abortSignal?: AbortSignal): Promise<string> {
  const configuredPath = process.env.TAKT_ALLOY_JAR;
  if (configuredPath) {
    const resolvedConfiguredPath = resolve(cwd, configuredPath);
    if (!isUsableFile(resolvedConfiguredPath)) {
      throw new Error(`Configured Alloy jar is not a readable file: ${resolvedConfiguredPath}`);
    }
    return resolvedConfiguredPath;
  }

  const cacheDirectory = join(cwd, '.takt', 'cache', 'alloy', ALLOY_VERSION);
  const cachedPath = join(cacheDirectory, 'alloy.jar');
  if (isUsableFile(cachedPath)) {
    assertTrustedAlloyJar(readFileSync(cachedPath), cachedPath);
    return cachedPath;
  }

  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(cacheDirectory, `.alloy-${randomUUID()}.tmp`);
  try {
    const timeoutSignal = AbortSignal.timeout(ALLOY_TIMEOUT_MS);
    const signal = abortSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([abortSignal, timeoutSignal]);
    const response = await fetch(ALLOY_JAR_URL, { signal });
    if (!response.ok) {
      throw new Error(`Alloy jar download failed with HTTP status ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new Error('Alloy jar download did not return a valid archive');
    }
    assertTrustedAlloyJar(bytes, ALLOY_JAR_URL);
    writeFileSync(temporaryPath, bytes, { mode: 0o600 });
    renameSync(temporaryPath, cachedPath);
    return cachedPath;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

async function javaVersion(
  cwd: string,
  abortSignal?: AbortSignal,
  runtimeState?: VerifyRunRuntimeState,
): Promise<number | undefined> {
  const result = await runProcess('java', ['-version'], cwd, 10_000, abortSignal, runtimeState);
  if (!isSuccessfulProcess(result)) {
    return undefined;
  }
  return detectJavaMajorVersion(`${result.stdout}\n${result.stderr}`);
}

async function runQuintCommand(
  quintCli: string,
  args: readonly string[],
  cwd: string,
  abortSignal?: AbortSignal,
  runtimeState?: VerifyRunRuntimeState,
): Promise<ProcessResult> {
  return runProcess(
    process.execPath,
    [quintCli, ...args],
    cwd,
    QUINT_TIMEOUT_MS,
    abortSignal,
    runtimeState,
  );
}

async function runAlloyCommand(
  jarPath: string,
  args: readonly string[],
  cwd: string,
  abortSignal?: AbortSignal,
  runtimeState?: VerifyRunRuntimeState,
): Promise<ProcessResult> {
  return runProcess(
    'java',
    ['-jar', jarPath, ...args],
    cwd,
    ALLOY_TIMEOUT_MS,
    abortSignal,
    runtimeState,
  );
}

interface QuintStageSet {
  readonly parse?: FormalSpecStageResult;
  readonly typecheck?: FormalSpecStageResult;
  readonly run?: FormalSpecStageResult;
  readonly verify?: FormalSpecStageResult;
}

function quintResultFromStages(
  stageSet: QuintStageSet,
  targets: QuintVerificationTargets,
): FormalSpecQuintResult {
  const stages = [stageSet.parse, stageSet.typecheck, stageSet.run, stageSet.verify]
    .filter((stage): stage is FormalSpecStageResult => stage !== undefined);
  const primary = aggregateStageResult(stages, 'No Quint verification stage was executed.');
  return {
    status: primary.status,
    ...(primary.message ? { message: primary.message } : {}),
    ...(stageSet.parse ? { parse: stageSet.parse } : {}),
    ...(stageSet.typecheck ? { typecheck: stageSet.typecheck } : {}),
    ...(stageSet.run ? { run: stageSet.run } : {}),
    ...(stageSet.verify ? { verify: stageSet.verify } : {}),
    invariants: targets.invariants.map(({ name }) => name),
    temporal: targets.temporal.map(({ name }) => name),
  };
}

/**
 * Extract and deterministically verify one newly generated provider response.
 * The response is intentionally the only input from the conversation layer.
 */
export async function runFormalSpecVerification(
  response: string,
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<FormalSpecVerificationResult> {
  abortSignal?.throwIfAborted();
  cleanupAbandonedVerifyRuns(cwd);
  let blocks: FormalSpecBlocks;
  try {
    blocks = extractFormalSpecBlocks(response);
  } catch (error) {
    return resultForUnexpectedError(error, false);
  }

  if (blocks.quint.length === 0 && blocks.alloy.length === 0) {
    return resultForNoBlocks('No formal specification blocks found.');
  }

  let runDirectory: string | undefined;
  let verificationStarted = false;
  const runtimeState: VerifyRunRuntimeState = { completedProcessIds: new Set() };
  try {
    verificationStarted = true;
    runDirectory = createRunDirectory(cwd);
    const specsDirectory = join(runDirectory, 'specs');
    const quintPath = blocks.quint.length > 0
      ? writeSpecification(runDirectory, 'spec.qnt', blocks.quint)
      : undefined;
    const alloyPath = blocks.alloy.length > 0
      ? writeSpecification(runDirectory, 'spec.als', blocks.alloy)
      : undefined;

    const stages: FormalSpecStageResult[] = [];
    let quint: FormalSpecQuintResult;
    let targets: QuintVerificationTargets = { invariants: [], temporal: [] };
    let mainModule: string | undefined;
    let targetScopeError: string | undefined;
    let quintStageSet: QuintStageSet = {};
    if (!quintPath) {
      quint = skippedQuintResult('No Quint specification block was present.');
      stages.push(quint);
    } else {
      const quintCli = resolveQuintCli();
      const parseJsonPath = join(specsDirectory, 'parse.json');
      let parse = specificationProcessStage(
        await runQuintCommand(
          quintCli,
          ['parse', quintPath, '--out', parseJsonPath],
          runDirectory,
          abortSignal,
          runtimeState,
        ),
      );

      let parseResult: unknown;
      if (parse.status === 'passed') {
        try {
          parseResult = JSON.parse(readFileSync(parseJsonPath, 'utf8')) as unknown;
        } catch (error) {
          const message = `Quint parse output could not be read: ${error instanceof Error ? error.message : String(error)}`;
          parse = errorStage(message);
        }
      }

      let typecheck: FormalSpecStageResult = skippedStage('Quint typechecking was skipped because parsing did not pass.');
      let run: FormalSpecStageResult = skippedStage('Quint simulation was skipped because typechecking did not pass.');
      if (parse.status === 'passed') {
        targets = selectQuintVerificationTargets(parseResult);
        mainModule = selectQuintMainModule(parseResult);
        targetScopeError = mainModule === undefined
          ? undefined
          : quintTargetScopeError(targets, mainModule);
        typecheck = specificationProcessStage(
          await runQuintCommand(
            quintCli,
            ['typecheck', quintPath],
            runDirectory,
            abortSignal,
            runtimeState,
          ),
        );
      }
      if (typecheck.status === 'passed') {
        if (mainModule === undefined) {
          run = errorStage(QUINT_MAIN_REQUIRED_MESSAGE);
        } else if (targetScopeError) {
          run = errorStage(targetScopeError);
        } else {
          const invariantNames = targets.invariants.map(({ name }) => name);
          const runArgs = [
            'run',
            quintPath,
            '--main',
            mainModule,
            '--backend',
            'typescript',
            '--max-samples',
            '1',
            '--max-steps',
            '20',
            '--verbosity',
            '0',
            ...(invariantNames.length > 0 ? ['--invariants', ...invariantNames] : []),
          ];
          run = verificationProcessStage(
            await runQuintCommand(quintCli, runArgs, runDirectory, abortSignal, runtimeState),
          );
        }
      }
      quintStageSet = { parse, typecheck, run };
      quint = quintResultFromStages(quintStageSet, targets);
    }

    const canRunQuintVerify = quintPath !== undefined
      && mainModule !== undefined
      && quint.parse?.status === 'passed'
      && quint.typecheck?.status === 'passed'
      && quint.run?.status === 'passed';
    const javaDetectionRan = alloyPath !== undefined || canRunQuintVerify;
    const detectedJavaMajorVersion = javaDetectionRan
      ? await javaVersion(runDirectory, abortSignal, runtimeState)
      : undefined;
    const hasJava17 = detectedJavaMajorVersion !== undefined && detectedJavaMajorVersion >= 17;
    const javaSkipMessage = alloyPath === undefined
      ? 'Java 17 or later was not detected; Quint verification was skipped.'
      : 'Java 17 or later was not detected; Quint verify and Alloy verification were skipped. Alloy specifications remain unverified.';

    if (canRunQuintVerify && hasJava17 && quintPath !== undefined && mainModule !== undefined) {
      const quintCli = resolveQuintCli();
      const verifyArgs = [
        'verify',
        quintPath,
        '--main',
        mainModule,
        ...(targets.temporal.length > 0 ? ['--backend', 'tlc'] : []),
        '--max-steps',
        '20',
        '--verbosity',
        '0',
        ...(targets.invariants.length > 0
          ? ['--invariant', targets.invariants.map(({ name }) => name).join(',')]
          : []),
        ...(targets.temporal.length > 0
          ? ['--temporal', targets.temporal.map(({ name }) => name).join(',')]
          : []),
      ];
      const verify = verificationProcessStage(
        await runQuintCommand(quintCli, verifyArgs, runDirectory, abortSignal, runtimeState),
      );
      if (quintPath) {
        quintStageSet = { ...quintStageSet, verify };
        quint = quintResultFromStages(quintStageSet, targets);
      }
    } else if (quintPath) {
      const message = canRunQuintVerify && javaDetectionRan
        ? javaSkipMessage
        : 'Quint verification was skipped because an earlier Quint stage did not pass.';
      quintStageSet = { ...quintStageSet, verify: skippedStage(message) };
      quint = quintResultFromStages(quintStageSet, targets);
    }
    if (quintPath) {
      stages.push(
        ...[quintStageSet.parse, quintStageSet.typecheck, quintStageSet.run, quintStageSet.verify]
          .filter((stage): stage is FormalSpecStageResult => stage !== undefined),
      );
    }

    let alloy: FormalSpecAlloyResult = skippedAlloyResult('Alloy verification was not run.');
    if (!alloyPath) {
      alloy = skippedAlloyResult('No Alloy specification block was present.');
      stages.push(alloy);
    } else if (!hasJava17) {
      alloy = skippedAlloyResult(javaSkipMessage);
      stages.push(alloy);
    } else {
      let jarPath: string | undefined;
      try {
        jarPath = await ensureAlloyJar(cwd, abortSignal);
      } catch (error) {
        const message = `Alloy Analyzer could not be prepared: ${error instanceof Error ? error.message : String(error)}`;
        alloy = { status: 'error', message };
        stages.push(alloy);
      }

      if (jarPath !== undefined) {
        const commandsProcess = await runAlloyCommand(
          jarPath,
          ['commands', alloyPath],
          runDirectory,
          abortSignal,
          runtimeState,
        );
        if (!isSuccessfulProcess(commandsProcess)) {
          alloy = { status: 'error', message: processFailureMessage(commandsProcess) };
          stages.push(alloy);
        } else if (commandsProcess.stdoutTruncated) {
          alloy = { status: 'error', message: ALLOY_COMMAND_OUTPUT_TRUNCATED_MESSAGE };
          stages.push(alloy);
        } else {
          const commands = parseAlloyCommands(commandsProcess.stdout);
          const checkTargets = selectAlloyCheckTargets(commands);
          if (checkTargets.length === 0) {
            alloy = { status: 'error', message: 'Alloy specification contains no check command.', commands };
            stages.push(alloy);
          } else {
            const checkResults: FormalSpecStageResult[] = [];
            for (const commandNumber of checkTargets) {
              const checkProcess = await runAlloyCommand(
                jarPath,
                ['exec', '--quiet', '--type', 'text', '--output', '-', '--command', String(commandNumber), alloyPath],
                runDirectory,
                abortSignal,
                runtimeState,
              );
              const check = isSuccessfulProcess(checkProcess) && checkProcess.stdout.trim() === ''
                ? passedStage()
                : checkProcess.outcome === 'exit' && checkProcess.status !== null
                  ? failedStage(checkProcess)
                  : errorStage(processFailureMessage(checkProcess));
              checkResults.push(check);
            }
            const primary = aggregateStageResult(checkResults, 'No Alloy check was executed.');
            alloy = {
              status: primary.status,
              ...(primary.message ? { message: primary.message } : {}),
              checks: checkTargets,
              commands,
            };
            stages.push(...checkResults);
          }
        }
      }
    }

    const primary = selectPrimaryStage(stages);
    return {
      verdict: primary.status === 'skipped' ? 'error' : primary.status,
      verificationStarted: true,
      ...(primary.message ? { message: primary.message } : {}),
      ...(detectedJavaMajorVersion === undefined ? {} : { javaMajorVersion: detectedJavaMajorVersion }),
      quint,
      alloy,
    };
  } catch (error) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? error;
    }
    return resultForUnexpectedError(error, verificationStarted);
  } finally {
    if (runDirectory) {
      removeVerifyRunDirectoryIfSafe(cwd, runDirectory, runtimeState);
    }
  }
}
