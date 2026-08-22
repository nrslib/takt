import { createWriteStream, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveNpmInvocation } from './npm-invocation.mjs';
import { runTeedCommand } from './teed-command.mjs';

export const RELEASE_GATE_SCRIPTS = Object.freeze([
  'build',
  'lint',
  'test',
  'test:it:all',
  'test:e2e:all',
]);
export const RELEASE_LOG_RELATIVE_PATH = '.takt/quality-gates/logs/check-release.log';
const RELEASE_LOG_MESSAGE = `[takt] check:release log: ${RELEASE_LOG_RELATIVE_PATH}`;
const releaseLogErrors = new WeakMap();

function writeMessage(message, logStream, output) {
  const line = `${message}\n`;
  logStream.write(line);
  output.write(line);
}

function openReleaseLog() {
  const logPath = join(process.cwd(), RELEASE_LOG_RELATIVE_PATH);
  mkdirSync(dirname(logPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const logStream = createWriteStream(logPath, { flags: 'w' });
    logStream.once('open', () => resolve(logStream));
    logStream.once('error', reject);
  });
}

function trackReleaseLogErrors(logStream) {
  releaseLogErrors.set(logStream, null);
  logStream.on('error', (error) => {
    if (releaseLogErrors.get(logStream) === null) {
      releaseLogErrors.set(logStream, error);
    }
  });
}

function getReleaseLogError(logStream) {
  return releaseLogErrors.get(logStream);
}

function closeReleaseLog(logStream) {
  const logError = getReleaseLogError(logStream) ?? logStream.errored;
  if (logError) {
    return Promise.reject(logError);
  }
  if (logStream.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    logStream.once('finish', resolve);
    logStream.once('error', reject);
    logStream.end();
  });
}

function notifyReleaseResult(message) {
  spawnSync(
    'osascript',
    ['-e', `display notification "${message}" with title "takt" subtitle "Release Check"`],
    { stdio: 'ignore' },
  );
}

async function runNpmCommand(npmArgs, logStream) {
  try {
    const invocation = resolveNpmInvocation(process.execPath, process.env.npm_execpath);
    return await runTeedCommand(invocation.executable, [...invocation.args, ...npmArgs], {
      logStream,
    });
  } catch (error) {
    writeMessage(
      `[takt] Failed to run npm ${npmArgs.join(' ')}: ${error.message}`,
      logStream,
      process.stderr,
    );
    return {
      code: 1,
      signal: null,
      output: '',
    };
  }
}

export async function runReleaseCheck(runCommand = runNpmCommand, openLog = openReleaseLog) {
  let logStream;
  try {
    logStream = await openLog();
  } catch (error) {
    process.stdout.write(`${RELEASE_LOG_MESSAGE}\n`);
    process.stderr.write(`[takt] Failed to open release log: ${error.message}\n`);
    const message = '[takt] check:release failed (exit=1)';
    notifyReleaseResult(message.replace('[takt] ', ''));
    process.stdout.write(`${message}\n`);
    return 1;
  }
  trackReleaseLogErrors(logStream);
  writeMessage(RELEASE_LOG_MESSAGE, logStream, process.stdout);

  let code = 0;
  try {
    for (const script of RELEASE_GATE_SCRIPTS) {
      const result = await runCommand(['run', script], logStream);
      if (result.code !== 0) {
        code = result.code;
        break;
      }
      const logError = getReleaseLogError(logStream);
      if (logError !== null) {
        code = 1;
        process.stderr.write(`[takt] Release log failed: ${logError.message}\n`);
        break;
      }
    }
  } catch (error) {
    code = 1;
    writeMessage(`[takt] Release check failed: ${error.message}`, logStream, process.stderr);
  }

  const message = code === 0
    ? '[takt] check:release passed'
    : `[takt] check:release failed (exit=${code})`;
  if (getReleaseLogError(logStream) === null) {
    logStream.write(`${message}\n`);
  }
  let closeError;
  try {
    await closeReleaseLog(logStream);
  } catch (error) {
    closeError = error;
    process.stderr.write(`[takt] Failed to close release log: ${error.message}\n`);
  }
  const finalCode = code === 0
    && (getReleaseLogError(logStream) !== null || closeError !== undefined)
    ? 1
    : code;
  const finalMessage = finalCode === 0
    ? '[takt] check:release passed'
    : `[takt] check:release failed (exit=${finalCode})`;
  notifyReleaseResult(finalMessage.replace('[takt] ', ''));
  process.stdout.write(`${finalMessage}\n`);
  return finalCode;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const code = await runReleaseCheck();
  process.exitCode = code;
}
