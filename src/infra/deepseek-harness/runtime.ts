import {
  DEEPSEEK_HARNESS_PYTHON_VERSION,
  DEEPSEEK_HARNESS_RUNTIME_VERSION,
  DEEPSEEK_HARNESS_SDK_VERSION,
} from './constants.js';
import { spawnManagedProcess, type ManagedProcess } from '../../shared/utils/index.js';
import {
  sanitizeSensitiveText,
  sanitizeSensitiveTextWithKnownValues,
} from '../../shared/utils/sensitiveText.js';

const DEEPSEEK_HARNESS_DIAGNOSTIC_ENV_NAME = /(?:KEY|TOKEN|PASSWORD|SECRET|AUTH|URL|PROXY)/iu;
const REDACTED_VALUE = '[REDACTED]';

export function redactDeepSeekHarnessDiagnostic(
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const sensitiveValues = Object.entries(environment)
    .filter(([name, entry]) => entry !== undefined && entry.length > 0 && DEEPSEEK_HARNESS_DIAGNOSTIC_ENV_NAME.test(name))
    .map(([, entry]) => entry as string)
    .sort((left, right) => right.length - left.length);
  let redacted = sanitizeSensitiveTextWithKnownValues(value, environment);
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length >= 4) {
      redacted = redacted.split(sensitiveValue).join(REDACTED_VALUE);
    }
  }
  return sanitizeSensitiveText(redacted).trim();
}

const PROBE_SCRIPT = `
import importlib.metadata
import inspect
import json
import sys
from deepseek_harness import DeepSeekHarness

sdk_distribution = importlib.metadata.distribution('deepseek-harness-sdk')
runtime_distribution = importlib.metadata.distribution('deepseek-harness-runtime-bin')
constructor_signature = inspect.signature(DeepSeekHarness)
try:
    constructor_signature.bind(
        provider='__takt_probe_provider__',
        model='__takt_probe_model__',
        cwd='.',
        runtime_cwd='.',
        max_tokens=None,
        session_root=None,
        cordis=None,
        request_timeout_seconds=1.0,
        shutdown_timeout_seconds=1.0,
    )
except TypeError as error:
    raise RuntimeError(
        'DeepSeek Harness SDK constructor signature is incompatible with the managed runtime contract'
    ) from error
print(json.dumps({
    'implementation': sys.implementation.name,
    'python': list(sys.version_info[:3]),
    'sdkVersion': sdk_distribution.metadata.get('Version'),
    'sdkRequiresPython': sdk_distribution.metadata.get('Requires-Python'),
    'runtimeVersion': runtime_distribution.metadata.get('Version'),
    'constructorParameters': list(constructor_signature.parameters),
}))
`;

interface ProbeCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface DeepSeekHarnessRuntimeInfo {
  implementation: string;
  python: readonly [number, number, number];
  sdkVersion: string;
  sdkRequiresPython: string | undefined;
  runtimeVersion: string;
  constructorParameters: readonly string[];
}

function createProbeTimeoutError(timeoutMs: number): Error {
  const error = new Error(`managed interpreter probe timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  return error;
}

async function runProbeCommand(
  pythonPath: string,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<ProbeCommandResult> {
  const probeController = new AbortController();
  const forwardAbort = (): void => {
    probeController.abort(abortSignal?.reason);
  };
  if (abortSignal?.aborted === true) {
    forwardAbort();
  } else {
    abortSignal?.addEventListener('abort', forwardAbort, { once: true });
  }
  const timeout = timeoutMs === undefined
    ? undefined
    : setTimeout(() => probeController.abort(createProbeTimeoutError(timeoutMs)), timeoutMs);
  const environment = { ...process.env };
  delete environment.PYTHONHOME;
  delete environment.PYTHONPATH;
  delete environment.VIRTUAL_ENV;

  let managed: ManagedProcess;
  try {
    managed = spawnManagedProcess(
      pythonPath,
      ['-c', PROBE_SCRIPT],
      {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
      probeController.signal,
      { terminationMode: 'process-tree' },
    );
  } catch (error) {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    abortSignal?.removeEventListener('abort', forwardAbort);
    throw error;
  }

  let stdout = '';
  let stderr = '';
  managed.child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  });
  managed.child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  });

  try {
    const { code } = await managed.wait();
    return { code, stdout, stderr };
  } catch (error) {
    await managed.terminate().catch(() => undefined);
    throw error;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    abortSignal?.removeEventListener('abort', forwardAbort);
  }
}

function compareVersions(left: readonly [number, number, number], right: readonly [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue < rightValue ? -1 : 1;
    }
  }
  return 0;
}

function pythonVersionSatisfies(
  requiresPython: string,
  version: readonly [number, number, number],
): boolean {
  const target: readonly [number, number, number] = version;
  const clauses = requiresPython.split(',').map((clause) => clause.trim()).filter((clause) => clause.length > 0);
  if (clauses.length === 0) {
    return false;
  }
  return clauses.every((clause) => {
    const match = /^(>=|<=|>|<|==|~=)\s*(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(clause);
    if (match === null) {
      return false;
    }
    const required: readonly [number, number, number] = [
      Number(match[2]),
      Number(match[3]),
      Number(match[4] ?? '0'),
    ];
    const comparison = compareVersions(target, required);
    switch (match[1]) {
      case '>=':
        return comparison >= 0;
      case '<=':
        return comparison <= 0;
      case '>':
        return comparison > 0;
      case '<':
        return comparison < 0;
      case '==':
        return comparison === 0;
      case '~=':
        return comparison >= 0 && target[0] === required[0];
      default:
        return false;
    }
  });
}

function parseProbeOutput(stdout: string): DeepSeekHarnessRuntimeInfo {
  const line = stdout.trim().split(/\r?\n/u).filter((value) => value.length > 0).at(-1);
  if (line === undefined) {
    throw new Error('managed interpreter probe returned no metadata');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error('managed interpreter probe returned malformed metadata', { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('managed interpreter probe returned malformed metadata');
  }
  const record = parsed as Record<string, unknown>;
  const python = record.python;
  const constructorParameters = record.constructorParameters;
  if (
    typeof record.implementation !== 'string'
    || !Array.isArray(python)
    || python.length !== 3
    || !python.every((value) => Number.isInteger(value))
    || typeof record.sdkVersion !== 'string'
    || (record.sdkRequiresPython !== undefined && typeof record.sdkRequiresPython !== 'string')
    || typeof record.runtimeVersion !== 'string'
    || !Array.isArray(constructorParameters)
    || !constructorParameters.every((value) => typeof value === 'string')
  ) {
    throw new Error(
      `managed interpreter probe returned incomplete metadata: ${redactDeepSeekHarnessDiagnostic(JSON.stringify(parsed), process.env)}`,
    );
  }
  return {
    implementation: record.implementation,
    python: python as [number, number, number],
    sdkVersion: record.sdkVersion,
    sdkRequiresPython: record.sdkRequiresPython,
    runtimeVersion: record.runtimeVersion,
    constructorParameters: constructorParameters as string[],
  };
}

async function probeDeepSeekHarnessRuntime(
  pythonPath: string,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<DeepSeekHarnessRuntimeInfo> {
  const result = await runProbeCommand(pythonPath, abortSignal, timeoutMs);
  if (result.code !== 0) {
    const diagnostic = redactDeepSeekHarnessDiagnostic(result.stderr, process.env);
    throw new Error(
      diagnostic.length === 0
        ? `managed interpreter probe exited with status ${String(result.code)}`
        : `managed interpreter probe failed: ${diagnostic}`,
    );
  }
  return parseProbeOutput(redactDeepSeekHarnessDiagnostic(result.stdout, process.env));
}

function assertDeepSeekHarnessRuntimeContract(
  info: DeepSeekHarnessRuntimeInfo,
): void {
  if (info.implementation !== 'cpython'
    || info.python[0] !== 3
    || info.python[1] !== 12) {
    throw new Error(
      `managed interpreter must be CPython ${DEEPSEEK_HARNESS_PYTHON_VERSION}; `
      + `found ${info.implementation} ${info.python.join('.')}`,
    );
  }
  if (info.sdkVersion !== DEEPSEEK_HARNESS_SDK_VERSION) {
    throw new Error(
      `managed DeepSeek Harness SDK version ${info.sdkVersion} does not match `
      + `${DEEPSEEK_HARNESS_SDK_VERSION}`,
    );
  }
  if (info.runtimeVersion !== DEEPSEEK_HARNESS_RUNTIME_VERSION) {
    throw new Error(
      `managed DeepSeek Harness runtime version ${info.runtimeVersion} does not match `
      + `${DEEPSEEK_HARNESS_RUNTIME_VERSION}`,
    );
  }
  if (info.sdkRequiresPython === undefined
    || !pythonVersionSatisfies(info.sdkRequiresPython, info.python)) {
    throw new Error(
      `DeepSeek Harness SDK Requires-Python ${info.sdkRequiresPython ?? '(missing)'} `
      + `does not allow CPython ${DEEPSEEK_HARNESS_PYTHON_VERSION}`,
    );
  }
  const requiredParameters = [
    'provider',
    'model',
    'cwd',
    'runtime_cwd',
    'max_tokens',
    'session_root',
    'cordis',
    'request_timeout_seconds',
    'shutdown_timeout_seconds',
  ];
  if (requiredParameters.some((parameter) => !info.constructorParameters.includes(parameter))) {
    throw new Error(
      'DeepSeek Harness SDK constructor signature is incompatible with the managed runtime contract',
    );
  }
}

export async function validateDeepSeekHarnessRuntime(
  pythonPath: string,
  abortSignal?: AbortSignal,
  timeoutMs?: number,
): Promise<DeepSeekHarnessRuntimeInfo> {
  const info = await probeDeepSeekHarnessRuntime(pythonPath, abortSignal, timeoutMs);
  assertDeepSeekHarnessRuntimeContract(info);
  return info;
}
