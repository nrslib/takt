import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  startProcessTreeCleanup,
} from './process-tree.mjs';
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;
const PROBE_REPORT_FLUSH_GRACE_MS = 25;
const PHASE_MARKERS = Object.freeze({
  ready: 'PROBE_READY',
  cleanupStart: 'PROBE_CLEANUP_START',
  failureCleanupStart: 'PROBE_FAILURE_CLEANUP_START',
});
const PROBE_RESULT_PREFIX = 'PROBE_RESULT ';

function readProbeProtocol(stdout) {
  let phase = 'startup';
  let protocolError;
  let resultCount = 0;
  let result;
  for (const line of stdout.split('\n').slice(0, -1)) {
    if (line === PHASE_MARKERS.ready) {
      if (phase !== 'startup') {
        protocolError = `PROBE_READY is invalid during ${phase}`;
        break;
      }
      phase = 'execution';
      continue;
    }
    if (line === PHASE_MARKERS.cleanupStart) {
      if (phase !== 'execution') {
        protocolError = `PROBE_CLEANUP_START is invalid during ${phase}`;
        break;
      }
      phase = 'cleanup';
      continue;
    }
    if (line === PHASE_MARKERS.failureCleanupStart) {
      if (phase !== 'startup' && phase !== 'execution') {
        protocolError = `PROBE_FAILURE_CLEANUP_START is invalid during ${phase}`;
        break;
      }
      phase = 'failure-cleanup';
      continue;
    }
    if (!line.startsWith(PROBE_RESULT_PREFIX)) {
      continue;
    }
    if (phase !== 'cleanup') {
      protocolError = `PROBE_RESULT is invalid during ${phase}`;
      break;
    }
    resultCount += 1;
    if (resultCount > 1) {
      protocolError = 'Probe emitted multiple PROBE_RESULT frames';
      break;
    }
    try {
      result = JSON.parse(line.slice(PROBE_RESULT_PREFIX.length));
    } catch {
      protocolError = 'Probe emitted an invalid PROBE_RESULT frame';
      break;
    }
  }
  return { phase, protocolError, resultCount, result };
}

export function parseProbeResult(stdout) {
  const protocol = readProbeProtocol(stdout);
  if (protocol.protocolError !== undefined) {
    throw new Error(`${protocol.protocolError}:\n${stdout}`);
  }
  if (protocol.resultCount !== 1) {
    throw new Error(`Probe did not emit a complete PROBE_RESULT after cleanup started:\n${stdout}`);
  }
  return protocol.result;
}

function appendBoundedOutput(current, chunk, remainingBytes) {
  const bytes = Buffer.from(chunk, 'utf8');
  if (bytes.length <= remainingBytes) {
    return { output: current + chunk, bytes: bytes.length, exceeded: false };
  }
  const decoder = new StringDecoder('utf8');
  const bounded = decoder.write(bytes.subarray(0, Math.max(0, remainingBytes)));
  return {
    output: current + bounded,
    bytes: Buffer.byteLength(bounded, 'utf8'),
    exceeded: true,
  };
}

export function reportProbePhase(phase) {
  const marker = PHASE_MARKERS[phase];
  if (marker === undefined) {
    throw new Error(`Unknown probe phase: ${String(phase)}`);
  }
  process.stdout.write(`${marker}\n`);
}

export function runProbeProcess(script, args, options) {
  return new Promise((resolve, reject) => {
    let phase = 'startup';
    let timedOut = false;
    let timedOutPhase;
    let timedOutDuration;
    let outputLimitExceeded = false;
    let protocolFailure;
    let terminationRequested = false;
    let termination = Promise.resolve();
    let settled = false;
    let reportSettlementScheduled = false;
    let reportSettlementId;
    let outputBytes = 0;
    let stdout = '';
    let stderr = '';
    let timeoutId;
    const child = spawn(process.execPath, [script, ...args], {
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const terminate = () => {
      if (terminationRequested) {
        return;
      }
      terminationRequested = true;
      termination = child.pid === undefined
        ? Promise.resolve()
        : startProcessTreeCleanup(child.pid);
      void termination.catch(() => undefined);
    };
    const settleFailure = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(reportSettlementId);
      reject(attachProbeCleanup(error, termination));
    };
    const settleSuccess = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(reportSettlementId);
      resolve({ stdout, stderr, cleanup: termination });
    };
    const scheduleReportSettlement = () => {
      if (reportSettlementScheduled) return;
      reportSettlementScheduled = true;
      reportSettlementId = setTimeout(() => {
        if (settled || protocolFailure !== undefined) return;
        terminate();
        settleSuccess();
      }, PROBE_REPORT_FLUSH_GRACE_MS);
    };
    const phaseTimeout = () => {
      if (phase === 'startup') return options.startupTimeout;
      if (phase === 'execution') return options.executionTimeout;
      return options.cleanupTimeout;
    };
    const schedulePhaseTimeout = () => {
      clearTimeout(timeoutId);
      const timeout = phaseTimeout();
      timeoutId = setTimeout(() => {
        if (terminationRequested || protocolFailure !== undefined || outputLimitExceeded) {
          return;
        }
        const protocol = readProbeProtocol(stdout);
        if (protocol.protocolError !== undefined) {
          protocolFailure = createProbeProtocolError(protocol.phase, stdout, stderr, protocol.protocolError);
          terminate();
          settleFailure(protocolFailure);
          return;
        }
        if (protocol.phase === 'cleanup' && protocol.resultCount === 1) {
          clearTimeout(timeoutId);
          scheduleReportSettlement();
          return;
        }
        timedOut = true;
        timedOutPhase = phase;
        timedOutDuration = timeout;
        const error = createProbeTimeoutError(phase, timeout, stdout, stderr);
        terminate();
        settleFailure(error);
      }, timeout);
    };
    const advancePhase = () => {
      if (settled) return;
      const protocol = readProbeProtocol(stdout);
      if (protocol.protocolError !== undefined) {
        protocolFailure = createProbeProtocolError(protocol.phase, stdout, stderr, protocol.protocolError);
        terminate();
        settleFailure(protocolFailure);
        return;
      }
      if (protocol.phase !== phase) {
        phase = protocol.phase;
        if (!terminationRequested) {
          schedulePhaseTimeout();
        }
      }
      if (protocol.phase === 'cleanup' && protocol.resultCount === 1) {
        clearTimeout(timeoutId);
        scheduleReportSettlement();
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const appended = appendBoundedOutput(stdout, chunk, MAX_PROBE_OUTPUT_BYTES - outputBytes);
      stdout = appended.output;
      outputBytes += appended.bytes;
      if (appended.exceeded && !outputLimitExceeded) {
        outputLimitExceeded = true;
        const error = createProbeOutputLimitError(stdout, stderr);
        terminate();
        settleFailure(error);
        return;
      }
      advancePhase();
    });
    child.stderr.on('data', (chunk) => {
      const appended = appendBoundedOutput(stderr, chunk, MAX_PROBE_OUTPUT_BYTES - outputBytes);
      stderr = appended.output;
      outputBytes += appended.bytes;
      if (appended.exceeded && !outputLimitExceeded) {
        outputLimitExceeded = true;
        const error = createProbeOutputLimitError(stdout, stderr);
        terminate();
        settleFailure(error);
      }
    });

    let spawnError;
    child.once('error', (error) => {
      spawnError = error;
      if (child.pid === undefined) {
        error.stdout = stdout;
        error.stderr = stderr;
        settleFailure(error);
      }
    });
    schedulePhaseTimeout();
    child.once('close', async (code, signal) => {
      if (settled) return;
      clearTimeout(timeoutId);
      const protocol = readProbeProtocol(stdout);
      if (protocol.protocolError !== undefined && protocolFailure === undefined) {
        protocolFailure = createProbeProtocolError(protocol.phase, stdout, stderr, protocol.protocolError);
      }
      if (timedOut || outputLimitExceeded || protocolFailure !== undefined) {
        const terminalError = protocolFailure ?? (timedOut
          ? createProbeTimeoutError(timedOutPhase ?? phase, timedOutDuration ?? phaseTimeout(), stdout, stderr)
          : outputLimitExceeded
            ? createProbeOutputLimitError(stdout, stderr)
            : undefined);
        settleFailure(terminalError);
        return;
      }
      if (spawnError !== undefined) {
        spawnError.stdout = stdout;
        spawnError.stderr = stderr;
        settleFailure(spawnError);
        return;
      }
      if (reportSettlementScheduled && terminationRequested && code === null) {
        settleSuccess();
        return;
      }
      if (code !== 0) {
        const error = createProbeExitError(code, signal, stdout, stderr);
        terminate();
        settleFailure(error);
        return;
      }
      if (protocol.protocolError !== undefined || protocol.resultCount !== 1 || protocol.phase !== 'cleanup') {
        const error = createProbeProtocolError(protocol.phase, stdout, stderr, protocol.protocolError);
        terminate();
        settleFailure(error);
        return;
      }
      terminate();
      settleSuccess();
    });
  });
}

function attachProbeOutput(error, stdout, stderr) {
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

function attachProbeCleanup(error, cleanup) {
  error.cleanup = cleanup;
  return error;
}

function createProbeTimeoutError(phase, timeout, stdout, stderr) {
  const error = attachProbeOutput(
    new Error(`Probe ${phase} phase timed out after ${timeout}ms`),
    stdout,
    stderr,
  );
  error.code = 'ETIMEDOUT';
  error.phase = phase;
  error.killed = true;
  error.signal = 'SIGTERM';
  return error;
}

function createProbeExitError(code, signal, stdout, stderr) {
  const error = attachProbeOutput(new Error(`Probe process exited with code ${String(code)}`), stdout, stderr);
  error.code = code;
  error.killed = false;
  error.signal = signal;
  return error;
}

function createProbeOutputLimitError(stdout, stderr) {
  const error = attachProbeOutput(
    new Error(`Probe process output exceeded ${MAX_PROBE_OUTPUT_BYTES} bytes`),
    stdout,
    stderr,
  );
  error.code = 'EOUTPUTLIMIT';
  error.killed = true;
  error.signal = 'SIGTERM';
  return error;
}

function createProbeProtocolError(phase, stdout, stderr, detail) {
  const error = attachProbeOutput(
    new Error(detail ?? `Probe process exited before completing the ${phase} phase`),
    stdout,
    stderr,
  );
  error.code = 'EPROBEPROTOCOL';
  error.phase = phase;
  return error;
}
