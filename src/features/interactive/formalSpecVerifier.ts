import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { spawnManagedProcess } from '../../shared/utils/spawn.js';

const require = createRequire(import.meta.url);

const QUINT_TIMEOUT_MS = 60_000;
const ALLOY_VERSION = '6.2.0';
const ALLOY_JAR_URL = `https://repo1.maven.org/maven2/org/alloytools/org.alloytools.alloy.dist/${ALLOY_VERSION}/org.alloytools.alloy.dist-${ALLOY_VERSION}.jar`;
const ALLOY_JAR_SHA256 = '6037cbeee0e8423c1c468447ed10f5fcf2f2743a2ffc39cb1c81f2905c0fdb9d';
const MAX_PROCESS_OUTPUT = 1024 * 1024;
const ALLOY_COMMAND_OUTPUT_TRUNCATED_MESSAGE = 'Alloy command enumeration output was truncated before all commands could be read.';
const ALLOY_RECEIPT_FILE = 'receipt.json';
const MAX_FAILURE_MESSAGE = 8_000;
const TLC_TIMEOUT_GUIDANCE = 'TLC exhaustively explores the entire state space; --max-steps does not limit TLC. Bound all state variables, especially int variables, to finite ranges.';
const TLC_OUTPUT_TRUNCATED_MESSAGE = 'TLC output was truncated at the capture limit; diagnostics may be missing.';
// Each bounded process refreshes the workspace timestamp, so cleanup measures
// inactivity rather than the total duration of sequential verification stages.
const STALE_VERIFY_RUN_MAX_AGE_MS = 60 * 60 * 1000;

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
  readonly commandResults?: readonly FormalSpecAlloyCommandResult[];
}

export type FormalSpecAlloyCommandResult = FormalSpecStageResult & AlloyParsedCommand;

export interface FormalSpecVerificationResult {
  readonly verdict: 'passed' | 'failed' | 'error';
  readonly verificationStarted: boolean;
  readonly message?: string;
  readonly javaMajorVersion?: number;
  readonly quint: FormalSpecQuintResult;
  readonly alloy: FormalSpecAlloyResult;
  readonly artifacts?: FormalSpecVerificationArtifacts;
}

export interface FormalSpecVerificationArtifacts {
  readonly runDirectory: string;
  readonly specifications: {
    readonly quint?: string;
    readonly alloy?: string;
  };
  readonly parseJson?: string;
  readonly alloyOutputs?: readonly string[];
  readonly logs: Readonly<Record<string, { readonly stdout: string; readonly stderr: string }>>;
}

export interface FormalSpecVerificationOptions {
  readonly abortSignal?: AbortSignal;
  readonly modelCheckTimeoutSeconds: number;
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
type QuintVerificationBackend = 'typescript' | 'apalache' | 'tlc';

interface ProcessResult {
  readonly outcome: ProcessOutcome;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly artifactWriteError?: string;
  readonly error?: string;
}

interface ProcessLogPaths {
  readonly stdout: string;
  readonly stderr: string;
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

const TLC_ERROR_LINE_PATTERN = /^\s*Error:/u;
const TLC_FAILURE_LINE_PATTERN = /^\s*\[failure\]/u;

function extractTlcDiagnostics(output: string): string | undefined {
  const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');
  const lines = output
    .replace(ansiEscapePattern, '')
    .split(/\r\n?|\n/u);
  const startIndex = lines.findIndex((line) => TLC_ERROR_LINE_PATTERN.test(line));
  if (startIndex < 0) {
    return undefined;
  }

  const failureIndex = lines.findIndex((line, index) => (
    index >= startIndex && TLC_FAILURE_LINE_PATTERN.test(line)
  ));
  const endIndex = failureIndex >= 0 ? failureIndex + 1 : lines.length;
  return lines
    .slice(startIndex, endIndex)
    .join('\n')
    .trim();
}

async function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeout: number,
  abortSignal?: AbortSignal,
  logPaths?: ProcessLogPaths,
): Promise<ProcessResult> {
  abortSignal?.throwIfAborted();
  const now = new Date();
  utimesSync(cwd, now, now);
  const processAbortController = new AbortController();
  let timedOut = false;
  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let stdoutLogFd: number | undefined;
  let stderrLogFd: number | undefined;
  let artifactWriteError: string | undefined;
  const closeLogFile = (fileDescriptor: number | undefined): undefined => {
    if (fileDescriptor === undefined) {
      return undefined;
    }
    try {
      closeSync(fileDescriptor);
    } catch (error) {
      artifactWriteError ??= error instanceof Error ? error.message : String(error);
    }
    return undefined;
  };
  const closeLogFiles = (): void => {
    stdoutLogFd = closeLogFile(stdoutLogFd);
    stderrLogFd = closeLogFile(stderrLogFd);
  };
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    processAbortController.abort(new Error(`Process timed out after ${timeout} ms`));
  }, timeout);
  const onAbort = (): void => {
    processAbortController.abort(abortSignal?.reason);
  };
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (logPaths) {
      try {
        stdoutLogFd = openSync(logPaths.stdout, 'w', 0o600);
        stderrLogFd = openSync(logPaths.stderr, 'w', 0o600);
      } catch (error) {
        artifactWriteError ??= error instanceof Error ? error.message : String(error);
        throw error;
      }
    }
    // A partially spawned process is killed with its tree through the abort
    // contract of spawnManagedProcess.
    const managedProcess = spawnManagedProcess(
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
    managedProcess.child.stdout?.setEncoding('utf8');
    managedProcess.child.stdout?.on('data', (chunk: string | Buffer) => {
      const text = toProcessText(chunk);
      const appended = appendProcessOutput(stdout, text);
      stdout = appended.output;
      stdoutTruncated ||= appended.truncated;
      if (stdoutLogFd !== undefined) {
        try {
          writeLogChunk(stdoutLogFd, text);
        } catch (error) {
          artifactWriteError ??= error instanceof Error ? error.message : String(error);
        }
      }
    });
    managedProcess.child.stderr?.setEncoding('utf8');
    managedProcess.child.stderr?.on('data', (chunk: string | Buffer) => {
      const text = toProcessText(chunk);
      const appended = appendProcessOutput(stderr, text);
      stderr = appended.output;
      stderrTruncated ||= appended.truncated;
      if (stderrLogFd !== undefined) {
        try {
          writeLogChunk(stderrLogFd, text);
        } catch (error) {
          artifactWriteError ??= error instanceof Error ? error.message : String(error);
        }
      }
    });

    const exit = await managedProcess.wait();
    abortSignal?.throwIfAborted();
    if (timedOut) {
      closeLogFiles();
      return {
        outcome: 'timeout',
        status: null,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        ...(artifactWriteError === undefined ? {} : { artifactWriteError }),
        error: `Process timed out after ${timeout} ms`,
      };
    }
    closeLogFiles();
    return {
      outcome: exit.signal === null ? 'exit' : 'signal',
      status: exit.code,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      ...(artifactWriteError === undefined ? {} : { artifactWriteError }),
    };
  } catch (error) {
    abortSignal?.throwIfAborted();
    if (timedOut) {
      closeLogFiles();
      return {
        outcome: 'timeout',
        status: null,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        ...(artifactWriteError === undefined ? {} : { artifactWriteError }),
        error: `Process timed out after ${timeout} ms`,
      };
    }
    closeLogFiles();
    return {
      outcome: 'spawn_error',
      status: null,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      ...(artifactWriteError === undefined ? {} : { artifactWriteError }),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    closeLogFiles();
    clearTimeout(timeoutHandle);
    abortSignal?.removeEventListener('abort', onAbort);
  }
}

function writeLogChunk(fileDescriptor: number, text: string): void {
  const chunk = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < chunk.length) {
    offset += writeSync(fileDescriptor, chunk, offset, chunk.length - offset);
  }
}

function rawProcessOutput(result: ProcessResult): string {
  return [result.stderr.trim(), result.stdout.trim()]
    .filter((detail) => detail.length > 0)
    .join('\n');
}

function truncateFailureMessage(message: string): string {
  return message.length > MAX_FAILURE_MESSAGE
    ? `${message.slice(0, MAX_FAILURE_MESSAGE)}\n[output truncated]`
    : message;
}

function formatProcessFailureMessage(
  result: ProcessResult,
  output: string,
  additionalMessage?: string,
): string {
  const details = [additionalMessage, result.error, result.artifactWriteError, output]
    .filter((detail): detail is string => detail !== undefined && detail.length > 0)
    .join('\n');
  const exitStatus = result.status === null ? 'unknown' : String(result.status);
  const defaultMessage = result.outcome === 'signal'
    ? 'Process was terminated by a signal.'
    : result.outcome === 'timeout'
      ? 'Process timed out.'
      : `Process exited with status ${exitStatus}`;
  return truncateFailureMessage(details || defaultMessage);
}

// Quint's `--out` JSON reports 0-based line/col; render 1-based for file:line:col.
function formatQuintParseErrorLocation(loc: unknown): string | undefined {
  if (!isRecord(loc) || typeof loc.source !== 'string') {
    return undefined;
  }
  const start = loc.start;
  if (!isRecord(start) || typeof start.line !== 'number' || typeof start.col !== 'number') {
    return loc.source;
  }
  return `${loc.source}:${start.line + 1}:${start.col + 1}`;
}

function formatQuintParseError(entry: unknown): string | undefined {
  if (!isRecord(entry) || typeof entry.explanation !== 'string') {
    return undefined;
  }
  const locs = Array.isArray(entry.locs) ? entry.locs : [];
  const location = formatQuintParseErrorLocation(locs[0]);
  return location === undefined ? entry.explanation : `${entry.explanation} (${location})`;
}

// Returns undefined (caller falls back unchanged) when parse.json is missing, unreadable, or has no errors[].
function quintParseErrorsMessage(parseJsonPath: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(parseJsonPath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.errors) || parsed.errors.length === 0) {
    return undefined;
  }
  const messages = parsed.errors
    .map(formatQuintParseError)
    .filter((message): message is string => message !== undefined);
  return messages.length > 0 ? truncateFailureMessage(messages.join('\n')) : undefined;
}

function processFailureMessage(result: ProcessResult): string {
  return formatProcessFailureMessage(result, rawProcessOutput(result));
}

function tlcFailureMessage(result: ProcessResult): string {
  // Preserve unrecognized failures instead of replacing their details with a generic summary.
  const output = extractTlcDiagnostics(result.stdout) ?? rawProcessOutput(result);
  const notices: string[] = [];
  if (result.outcome === 'timeout') {
    notices.push(TLC_TIMEOUT_GUIDANCE);
  }
  if (result.stdoutTruncated || result.stderrTruncated) {
    notices.push(TLC_OUTPUT_TRUNCATED_MESSAGE);
  }
  return formatProcessFailureMessage(result, output, notices.join('\n'));
}

function passedStage(): FormalSpecStageResult {
  return { status: 'passed' };
}

function skippedStage(message: string): FormalSpecStageResult {
  return { status: 'skipped', message };
}

function errorStage(message: string): FormalSpecStageResult {
  return { status: 'error', message };
}

function isSuccessfulProcess(result: ProcessResult): boolean {
  return result.outcome === 'exit' && result.status === 0 && result.artifactWriteError === undefined;
}

function specificationProcessStage(result: ProcessResult): FormalSpecStageResult {
  return isSuccessfulProcess(result)
    ? passedStage()
    : errorStage(processFailureMessage(result));
}

function verificationProcessStage(
  result: ProcessResult,
  backend: QuintVerificationBackend,
): FormalSpecStageResult {
  if (isSuccessfulProcess(result)) {
    return passedStage();
  }
  const message = backend === 'tlc' ? tlcFailureMessage(result) : processFailureMessage(result);
  return result.outcome === 'exit' && result.status !== null
    ? { status: 'failed', message }
    : errorStage(message);
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

/** Remove abandoned verify run workspaces older than the stale threshold. */
function cleanupAbandonedVerifyRuns(cwd: string): void {
  const runsDirectory = join(cwd, '.takt', 'runs');
  let entries;
  try {
    entries = readdirSync(runsDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  const staleBefore = Date.now() - STALE_VERIFY_RUN_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('verify-')) continue;
    const directory = join(runsDirectory, entry.name);
    try {
      if (statSync(directory).mtimeMs < staleBefore) {
        removeVerifyRunDirectory(directory);
      }
    } catch {
      // A workspace removed concurrently is not an error.
    }
  }
}

function removeVerifyRunDirectory(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort and must not replace the verification result.
  }
}

function createRunDirectory(cwd: string): string {
  const runsDirectory = join(cwd, '.takt', 'runs');
  mkdirSync(runsDirectory, { recursive: true });
  const runDirectory = mkdtempSync(join(runsDirectory, 'verify-'));
  try {
    mkdirSync(join(runDirectory, 'specs'), { mode: 0o700 });
    mkdirSync(join(runDirectory, 'logs'), { mode: 0o700 });
  } catch (error) {
    removeVerifyRunDirectory(runDirectory);
    throw error;
  }
  return runDirectory;
}

function createFormalSpecVerificationArtifacts(
  runDirectory: string,
  quintSpecificationPath: string | undefined,
  alloySpecificationPath: string | undefined,
  parseJsonPath: string | undefined,
  logs: Readonly<Record<string, ProcessLogPaths>>,
  alloyOutputs: readonly string[],
): FormalSpecVerificationArtifacts {
  return {
    runDirectory,
    specifications: {
      ...(quintSpecificationPath ? { quint: quintSpecificationPath } : {}),
      ...(alloySpecificationPath ? { alloy: alloySpecificationPath } : {}),
    },
    ...(parseJsonPath ? { parseJson: parseJsonPath } : {}),
    ...(alloyOutputs.length > 0 ? { alloyOutputs: [...alloyOutputs] } : {}),
    logs: Object.fromEntries(Object.entries(logs).map(([stage, paths]) => [stage, { ...paths }])),
  };
}

/** Remove verification artifacts after the interpretation call has finished. */
export function cleanupFormalSpecVerificationArtifacts(result: FormalSpecVerificationResult): void {
  if (result.artifacts) {
    removeVerifyRunDirectory(result.artifacts.runDirectory);
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
    const match = /^\s*(\d+)\s*\.\s+(Check|Run)\s+(.+?)\s*$/iu.exec(line);
    if (!match) {
      if (line.trim() !== '') {
        throw new Error('Unrecognized Alloy command enumeration output.');
      }
      continue;
    }
    const number = Number.parseInt(match[1] ?? '', 10);
    const type = (match[2] ?? '').toLowerCase();
    const label = (match[3] ?? '').replace(/\s+(?:for|expect)\s+.+$/iu, '').trim();
    if (number !== commands.length || !label) {
      throw new Error('Incomplete Alloy command enumeration output.');
    }
    commands.push({ number, type, label });
  }
  return commands;
}

interface AlloyExpectationMismatch {
  readonly expects: number;
  readonly satisfied: boolean;
}

function alloyExpectationMismatch(
  result: ProcessResult,
  command: AlloyParsedCommand,
): AlloyExpectationMismatch | undefined {
  if (result.outcome !== 'exit' || result.status !== 1 || result.artifactWriteError !== undefined
    || result.stdout.trim() !== '' || result.stdoutTruncated || result.stderrTruncated) {
    return undefined;
  }
  const match = /^Error\r?\n {2}0\. '(Run|Check) (.+) expect ([01])' was (not )?satisfied against expectation\r?\n?$/u.exec(result.stderr);
  if (!match || match[1]?.toLowerCase() !== command.type) {
    return undefined;
  }
  const label = match[2]?.replace(/\s+for\s+.+$/iu, '').trim();
  if (label !== command.label) {
    return undefined;
  }
  return { expects: Number(match[3]), satisfied: match[4] === undefined };
}

function alloyCommandStage(
  result: ProcessResult,
  command: AlloyParsedCommand,
  outputDirectory: string,
  artifacts: string[],
): FormalSpecStageResult {
  try {
    for (const entry of readdirSync(outputDirectory, { withFileTypes: true })) {
      if (entry.isFile()) {
        const path = join(outputDirectory, entry.name);
        chmodSync(path, 0o600);
        artifacts.push(path);
      }
    }
    const expectationMismatch = alloyExpectationMismatch(result, command);
    if (!isSuccessfulProcess(result) && expectationMismatch === undefined) {
      return errorStage(processFailureMessage(result));
    }
    if (result.stdoutTruncated || result.stderrTruncated) {
      return errorStage('Alloy execution output was truncated; the command result is incomplete.');
    }
    const receiptPath = join(outputDirectory, ALLOY_RECEIPT_FILE);
    if (statSync(receiptPath).size > MAX_PROCESS_OUTPUT) {
      return errorStage('Alloy receipt exceeds the capture limit; the command result is incomplete.');
    }
    const receipt: unknown = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (!isRecord(receipt) || !isRecord(receipt.commands)) {
      return errorStage('Alloy receipt contains no command results.');
    }
    const entries = Object.values(receipt.commands);
    const entry = entries[0];
    if (entries.length !== 1 || !isRecord(entry)
      || entry.name !== command.label || entry.type !== command.type
      || Object.keys(receipt.commands)[0] !== command.label
      || typeof entry.source !== 'string' || entry.source.trim().length === 0) {
      return errorStage('Alloy receipt does not match the selected command.');
    }
    const hasSolution = Object.hasOwn(entry, 'solution');
    if (hasSolution && (!Array.isArray(entry.solution) || entry.solution.length !== 1
      || !isRecord(entry.solution[0]) || !Array.isArray(entry.solution[0].instances)
      || entry.solution[0].instances.length === 0
      || !entry.solution[0].instances.every((instance: unknown) => isRecord(instance)))) {
      return errorStage('Alloy receipt contains an incomplete solution.');
    }
    if (hasSolution && !isUsableFile(join(outputDirectory, `${command.label}-solution-0.txt`))) {
      return errorStage('Alloy instance or counterexample artifact is missing or empty.');
    }
    // Alloy's receipt serializer omits expects when its numeric value is zero.
    const receiptExpects = entry.expects === undefined ? 0 : entry.expects;
    if (expectationMismatch !== undefined && (receiptExpects !== expectationMismatch.expects
      || hasSolution !== expectationMismatch.satisfied
      || Number(hasSolution) === expectationMismatch.expects)) {
      return errorStage(processFailureMessage(result));
    }
    const passed = command.type === 'run' ? hasSolution : !hasSolution;
    const message = command.type === 'run'
      ? hasSolution ? 'An instance was found within the specified scope.' : 'No instance exists within the specified scope (UNSAT).'
      : hasSolution ? 'A counterexample was found within the specified scope.' : 'No counterexample was found within the specified scope.';
    return {
      status: passed ? 'passed' : 'failed',
      message: expectationMismatch === undefined
        ? message
        : `${message} The Alloy expect annotation disagreed; TAKT uses run/check semantics.`,
    };
  } catch (error) {
    return errorStage(`Alloy command result could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
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

async function ensureAlloyJar(
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<string> {
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
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
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
  logPaths?: ProcessLogPaths,
): Promise<number | undefined> {
  const result = await runProcess('java', ['-version'], cwd, 10_000, abortSignal, logPaths);
  if (result.artifactWriteError !== undefined) {
    throw new Error(result.artifactWriteError);
  }
  if (!isSuccessfulProcess(result)) {
    return undefined;
  }
  return detectJavaMajorVersion(`${result.stdout}\n${result.stderr}`);
}

async function runQuintCommand(
  quintCli: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  logPaths?: ProcessLogPaths,
): Promise<ProcessResult> {
  return runProcess(
    process.execPath,
    [quintCli, ...args],
    cwd,
    timeoutMs,
    abortSignal,
    logPaths,
  );
}

async function runAlloyCommand(
  jarPath: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  logPaths?: ProcessLogPaths,
): Promise<ProcessResult> {
  return runProcess(
    'java',
    ['-jar', jarPath, ...args],
    cwd,
    timeoutMs,
    abortSignal,
    logPaths,
  );
}

function createProcessLogPaths(
  logsDirectory: string,
  stage: string,
  logs: Record<string, ProcessLogPaths>,
): ProcessLogPaths {
  const paths = {
    stdout: join(logsDirectory, `${stage}.stdout.log`),
    stderr: join(logsDirectory, `${stage}.stderr.log`),
  };
  logs[stage] = paths;
  return paths;
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
 * The conversation layer supplies only the response and resolved verifier options.
 */
export async function runFormalSpecVerification(
  response: string,
  cwd: string,
  options: FormalSpecVerificationOptions,
): Promise<FormalSpecVerificationResult> {
  const { abortSignal, modelCheckTimeoutSeconds } = options;
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

  const modelCheckTimeoutMs = modelCheckTimeoutSeconds * 1000;

  let runDirectory: string | undefined;
  let quintSpecificationPath: string | undefined;
  let alloySpecificationPath: string | undefined;
  let parseJsonPath: string | undefined;
  let verificationStarted = false;
  const processLogs: Record<string, ProcessLogPaths> = {};
  const alloyOutputs: string[] = [];
  try {
    verificationStarted = true;
    runDirectory = createRunDirectory(cwd);
    const specsDirectory = join(runDirectory, 'specs');
    const logsDirectory = join(runDirectory, 'logs');
    quintSpecificationPath = blocks.quint.length > 0
      ? writeSpecification(runDirectory, 'spec.qnt', blocks.quint)
      : undefined;
    alloySpecificationPath = blocks.alloy.length > 0
      ? writeSpecification(runDirectory, 'spec.als', blocks.alloy)
      : undefined;

    const stages: FormalSpecStageResult[] = [];
    let quint: FormalSpecQuintResult;
    let targets: QuintVerificationTargets = { invariants: [], temporal: [] };
    let mainModule: string | undefined;
    let targetScopeError: string | undefined;
    let quintStageSet: QuintStageSet = {};
    if (!quintSpecificationPath) {
      quint = skippedQuintResult('No Quint specification block was present.');
      stages.push(quint);
    } else {
      const quintCli = resolveQuintCli();
      parseJsonPath = join(specsDirectory, 'parse.json');
      writeFileSync(parseJsonPath, '', { encoding: 'utf8', mode: 0o600 });
      let parse = specificationProcessStage(
        await runQuintCommand(
          quintCli,
          ['parse', quintSpecificationPath, '--out', parseJsonPath],
          runDirectory,
          QUINT_TIMEOUT_MS,
          abortSignal,
          createProcessLogPaths(logsDirectory, 'quint-parse', processLogs),
        ),
      );
      if (existsSync(parseJsonPath)) {
        chmodSync(parseJsonPath, 0o600);
      }
      if (parse.status === 'error') {
        const detailedMessage = quintParseErrorsMessage(parseJsonPath);
        if (detailedMessage !== undefined) {
          parse = errorStage(detailedMessage);
        }
      }

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
            ['typecheck', quintSpecificationPath],
            runDirectory,
            QUINT_TIMEOUT_MS,
            abortSignal,
            createProcessLogPaths(logsDirectory, 'quint-typecheck', processLogs),
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
            quintSpecificationPath,
            '--main',
            mainModule,
            '--backend',
            'typescript',
            '--max-samples',
            '1',
            '--max-steps',
            '20',
            '--verbosity',
            '2',
            ...(invariantNames.length > 0 ? ['--invariants', ...invariantNames] : []),
          ];
          run = verificationProcessStage(
            await runQuintCommand(
              quintCli,
              runArgs,
              runDirectory,
              QUINT_TIMEOUT_MS,
              abortSignal,
              createProcessLogPaths(logsDirectory, 'quint-run', processLogs),
            ),
            'typescript',
          );
        }
      }
      quintStageSet = { parse, typecheck, run };
      quint = quintResultFromStages(quintStageSet, targets);
    }

    const canRunQuintVerify = quintSpecificationPath !== undefined
      && mainModule !== undefined
      && quint.parse?.status === 'passed'
      && quint.typecheck?.status === 'passed'
      && quint.run?.status === 'passed';
    const javaDetectionRan = alloySpecificationPath !== undefined || canRunQuintVerify;
    const detectedJavaMajorVersion = javaDetectionRan
      ? await javaVersion(
        runDirectory,
        abortSignal,
        createProcessLogPaths(logsDirectory, 'java-version', processLogs),
      )
      : undefined;
    const hasJava17 = detectedJavaMajorVersion !== undefined && detectedJavaMajorVersion >= 17;
    const javaSkipMessage = alloySpecificationPath === undefined
      ? 'Java 17 or later was not detected; Quint verification was skipped.'
      : 'Java 17 or later was not detected; Quint verify and Alloy verification were skipped. Alloy specifications remain unverified.';

    if (canRunQuintVerify && hasJava17 && quintSpecificationPath !== undefined && mainModule !== undefined) {
      const quintCli = resolveQuintCli();
      const verifyBackend: QuintVerificationBackend = targets.temporal.length > 0 ? 'tlc' : 'apalache';
      const verifyArgs = [
        'verify',
        quintSpecificationPath,
        '--main',
        mainModule,
        ...(verifyBackend === 'tlc' ? ['--backend', verifyBackend] : []),
        '--max-steps',
        '20',
        ...(verifyBackend === 'tlc' ? [] : ['--verbosity', '0']),
        ...(targets.invariants.length > 0
          ? ['--invariant', targets.invariants.map(({ name }) => name).join(',')]
          : []),
        ...(targets.temporal.length > 0
          ? ['--temporal', targets.temporal.map(({ name }) => name).join(',')]
          : []),
      ];
      const verify = verificationProcessStage(
        await runQuintCommand(
          quintCli,
          verifyArgs,
          runDirectory,
          modelCheckTimeoutMs,
          abortSignal,
          createProcessLogPaths(logsDirectory, 'quint-verify', processLogs),
        ),
        verifyBackend,
      );
      if (quintSpecificationPath) {
        quintStageSet = { ...quintStageSet, verify };
        quint = quintResultFromStages(quintStageSet, targets);
      }
    } else if (quintSpecificationPath) {
      const message = canRunQuintVerify && javaDetectionRan
        ? javaSkipMessage
        : 'Quint verification was skipped because an earlier Quint stage did not pass.';
      quintStageSet = { ...quintStageSet, verify: skippedStage(message) };
      quint = quintResultFromStages(quintStageSet, targets);
    }
    if (quintSpecificationPath) {
      stages.push(
        ...[quintStageSet.parse, quintStageSet.typecheck, quintStageSet.run, quintStageSet.verify]
          .filter((stage): stage is FormalSpecStageResult => stage !== undefined),
      );
    }

    let alloy: FormalSpecAlloyResult = skippedAlloyResult('Alloy verification was not run.');
    if (!alloySpecificationPath) {
      alloy = skippedAlloyResult('No Alloy specification block was present.');
      stages.push(alloy);
    } else if (!hasJava17) {
      alloy = skippedAlloyResult(javaSkipMessage);
      stages.push(alloy);
    } else {
      let jarPath: string | undefined;
      try {
        jarPath = await ensureAlloyJar(cwd, modelCheckTimeoutMs, abortSignal);
      } catch (error) {
        const message = `Alloy Analyzer could not be prepared: ${error instanceof Error ? error.message : String(error)}`;
        alloy = { status: 'error', message };
        stages.push(alloy);
      }

      if (jarPath !== undefined) {
        const commandsProcess = await runAlloyCommand(
          jarPath,
          ['commands', alloySpecificationPath],
          runDirectory,
          modelCheckTimeoutMs,
          abortSignal,
          createProcessLogPaths(logsDirectory, 'alloy-commands', processLogs),
        );
        if (!isSuccessfulProcess(commandsProcess)) {
          alloy = { status: 'error', message: processFailureMessage(commandsProcess) };
          stages.push(alloy);
        } else if (commandsProcess.stdoutTruncated || commandsProcess.stderrTruncated) {
          alloy = { status: 'error', message: ALLOY_COMMAND_OUTPUT_TRUNCATED_MESSAGE };
          stages.push(alloy);
        } else {
          let commands: AlloyParsedCommand[];
          try {
            commands = parseAlloyCommands(commandsProcess.stdout);
          } catch (error) {
            commands = [];
            alloy = errorStage(error instanceof Error ? error.message : String(error));
          }
          if (commands.length === 0) {
            if (alloy.status !== 'error') {
              alloy = { status: 'error', message: 'Alloy specification contains no run or check command.', commands };
            }
            stages.push(alloy);
          } else {
            const commandResults: FormalSpecAlloyCommandResult[] = [];
            for (const command of commands) {
              const stageName = `alloy-${command.type}-${command.number}`;
              const outputDirectory = join(runDirectory, stageName);
              mkdirSync(outputDirectory, { mode: 0o700 });
              const commandProcess = await runAlloyCommand(
                jarPath,
                ['exec', '--quiet', '--type', 'text', '--output', outputDirectory, '--command', String(command.number), alloySpecificationPath],
                runDirectory,
                modelCheckTimeoutMs,
                abortSignal,
                createProcessLogPaths(logsDirectory, stageName, processLogs),
              );
              const result = alloyCommandStage(commandProcess, command, outputDirectory, alloyOutputs);
              commandResults.push({
                ...command,
                ...result,
                ...(result.message ? { message: `${command.type} ${command.number} (${command.label}): ${result.message}` } : {}),
              });
            }
            const primary = aggregateStageResult(commandResults, 'No Alloy command was executed.');
            alloy = {
              status: primary.status,
              ...(primary.message ? { message: primary.message } : {}),
              checks: selectAlloyCheckTargets(commands),
              commands,
              commandResults,
            };
            stages.push(...commandResults);
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
      artifacts: createFormalSpecVerificationArtifacts(
        runDirectory,
        quintSpecificationPath,
        alloySpecificationPath,
        parseJsonPath,
        processLogs,
        alloyOutputs,
      ),
    };
  } catch (error) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? error;
    }
    const result = resultForUnexpectedError(error, verificationStarted);
    return runDirectory === undefined
      ? result
      : {
        ...result,
        artifacts: createFormalSpecVerificationArtifacts(
          runDirectory,
          quintSpecificationPath,
          alloySpecificationPath,
          parseJsonPath,
          processLogs,
          alloyOutputs,
        ),
      };
  } finally {
    if (runDirectory && abortSignal?.aborted) {
      removeVerifyRunDirectory(runDirectory);
    }
  }
}
