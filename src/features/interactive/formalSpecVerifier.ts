import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { spawnManagedProcess } from '../../shared/utils/spawn.js';

const require = createRequire(import.meta.url);

const QUINT_TIMEOUT_MS = 60_000;
const ALLOY_TIMEOUT_MS = 60_000;
const ALLOY_VERSION = '6.2.0';
const ALLOY_JAR_URL = `https://repo1.maven.org/maven2/org/alloytools/org.alloytools.alloy.dist/${ALLOY_VERSION}/org.alloytools.alloy.dist-${ALLOY_VERSION}.jar`;
const MAX_PROCESS_OUTPUT = 1024 * 1024;
const MAX_FAILURE_MESSAGE = 8_000;

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

function appendProcessOutput(current: string, chunk: string): string {
  const remaining = MAX_PROCESS_OUTPUT - current.length;
  return remaining > 0 ? current + chunk.slice(0, remaining) : current;
}

async function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeout: number,
  abortSignal?: AbortSignal,
): Promise<ProcessResult> {
  abortSignal?.throwIfAborted();
  const processAbortController = new AbortController();
  let timedOut = false;
  let stdout = '';
  let stderr = '';
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    processAbortController.abort(new Error(`Process timed out after ${timeout} ms`));
  }, timeout);
  const onAbort = (): void => {
    processAbortController.abort(abortSignal?.reason);
  };
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
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
      stdout = appendProcessOutput(stdout, toProcessText(chunk));
    });
    managedProcess.child.stderr?.setEncoding('utf8');
    managedProcess.child.stderr?.on('data', (chunk: string | Buffer) => {
      stderr = appendProcessOutput(stderr, toProcessText(chunk));
    });

    const exit = await managedProcess.wait();
    abortSignal?.throwIfAborted();
    if (timedOut) {
      return {
        outcome: 'timeout',
        status: null,
        stdout,
        stderr,
        error: `Process timed out after ${timeout} ms`,
      };
    }
    return {
      outcome: exit.signal === null ? 'exit' : 'signal',
      status: exit.code,
      stdout,
      stderr,
    };
  } catch (error) {
    abortSignal?.throwIfAborted();
    if (timedOut) {
      return {
        outcome: 'timeout',
        status: null,
        stdout,
        stderr,
        error: `Process timed out after ${timeout} ms`,
      };
    }
    return {
      outcome: 'spawn_error',
      status: null,
      stdout,
      stderr,
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

function createRunDirectory(cwd: string): string {
  const runsDirectory = join(cwd, '.takt', 'runs');
  mkdirSync(runsDirectory, { recursive: true, mode: 0o700 });
  const runDirectory = `${runsDirectory}/verify-`;
  let directory: string | undefined;
  try {
    directory = mkdtempSync(runDirectory);
    mkdirSync(join(directory, 'specs'), { mode: 0o700 });
    return directory;
  } catch (error) {
    if (directory !== undefined) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Preserve the original creation error when cleanup itself fails.
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

async function ensureAlloyJar(cwd: string, abortSignal?: AbortSignal): Promise<string> {
  const configuredPath = process.env.TAKT_ALLOY_JAR;
  if (configuredPath) {
    if (!isUsableFile(configuredPath)) {
      throw new Error(`Configured Alloy jar is not a readable file: ${configuredPath}`);
    }
    return configuredPath;
  }

  const cacheDirectory = join(cwd, '.takt', 'cache', 'alloy', ALLOY_VERSION);
  const cachedPath = join(cacheDirectory, 'alloy.jar');
  if (isUsableFile(cachedPath)) {
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
    writeFileSync(temporaryPath, bytes, { mode: 0o600 });
    renameSync(temporaryPath, cachedPath);
    return cachedPath;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

async function javaVersion(cwd: string, abortSignal?: AbortSignal): Promise<number | undefined> {
  const result = await runProcess('java', ['-version'], cwd, 10_000, abortSignal);
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
): Promise<ProcessResult> {
  return runProcess(process.execPath, [quintCli, ...args], cwd, QUINT_TIMEOUT_MS, abortSignal);
}

async function runAlloyCommand(
  jarPath: string,
  args: readonly string[],
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<ProcessResult> {
  return runProcess('java', ['-jar', jarPath, ...args], cwd, ALLOY_TIMEOUT_MS, abortSignal);
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
        await runQuintCommand(quintCli, ['parse', quintPath, '--out', parseJsonPath], runDirectory, abortSignal),
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
          await runQuintCommand(quintCli, ['typecheck', quintPath], runDirectory, abortSignal),
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
            await runQuintCommand(quintCli, runArgs, runDirectory, abortSignal),
          );
        }
      }
      quintStageSet = { parse, typecheck, run };
      quint = quintResultFromStages(quintStageSet, targets);
    }

    const detectedJavaMajorVersion = await javaVersion(runDirectory, abortSignal);
    const hasJava17 = detectedJavaMajorVersion !== undefined && detectedJavaMajorVersion >= 17;
    const javaSkipMessage = 'Java 17 or later was not detected; Quint verify and Alloy verification were skipped. Alloy specifications remain unverified.';

    if (quintPath && hasJava17
      && mainModule !== undefined
      && quint.parse?.status === 'passed'
      && quint.typecheck?.status === 'passed'
      && quint.run?.status === 'passed') {
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
        await runQuintCommand(quintCli, verifyArgs, runDirectory, abortSignal),
      );
      if (quintPath) {
        quintStageSet = { ...quintStageSet, verify };
        quint = quintResultFromStages(quintStageSet, targets);
      }
    } else if (quintPath) {
      const message = hasJava17
        ? 'Quint verification was skipped because an earlier Quint stage did not pass.'
        : javaSkipMessage;
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
        const commandsProcess = await runAlloyCommand(jarPath, ['commands', alloyPath], runDirectory, abortSignal);
        if (!isSuccessfulProcess(commandsProcess)) {
          alloy = { status: 'error', message: processFailureMessage(commandsProcess) };
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
      rmSync(runDirectory, { recursive: true, force: true });
    }
  }
}
