// birpc's RPC deadline is a fixed 60s. The adaptive local unit-shard wave plus
// fork workers on one developer machine can starve a worker's event loop past
// it, and vitest then exits non-zero while every test passed. `npm test`
// re-measures a shard exactly once when its output carries that shape and
// nothing else, so the gate reports what the machine measured instead of a
// scheduling artifact.
// The blocking pull-request matrix runs one shard per runner, so a timeout
// there remains fatal. The on-demand `/ci` job is a documented single-runner
// exception: it sets TAKT_BIRPC_REMEASURE_ON_CI=1 and opts into the same strict
// one-time re-measurement. Other CI paths remain fatal.
// Anchored at both ends: vitest appends ` with "<args>"` for fetch, transform,
// resolveId, and onUnhandledError timeouts, and those carry real information
// about what stalled. Only the bare onTaskUpdate report is the known artifact.
const BIRPC_NOISE_MESSAGE = /^\[vitest-worker\]: Timeout calling "onTaskUpdate"$/;
export const BIRPC_REMEASURE_ON_CI_ENV = 'TAKT_BIRPC_REMEASURE_ON_CI';

// vitest prints every error it reports as `<Name>: <message>` at column 0
// (`printErrorMessage`). The name is matched as any bare token rather than
// `*Error` / `*Exception`, so an error class named `DatabaseFailure` is
// whitelisted against too instead of being invisible here. Matching only
// column 0 is deliberate: indented text is stack frames, diffs, and code
// frames, which repeat error wording without being a separate error.
const ERROR_HEADLINE = /^([A-Za-z_$][\w$.]*|Unknown Error): (.*)$/;

const TESTS_SUMMARY_LINE = /^[ \t]*Tests[ \t]+(.+) \(\d+\)$/m;
const SUMMARY_STATE_SEGMENT = /^(\d+) (failed|passed|skipped|todo)$/;

// `output` is stdout and stderr concatenated in arrival order, so a chunk
// boundary can interleave the two and break a summary or headline line apart.
// Every such case fails one of the checks below and the shard is reported as a
// failure — interleaving can only cost a rescue, never grant one.
export function isBirpcNoiseOnlyFailure({ output, isCI, remeasureOnCI }) {
  if (isCI && !remeasureOnCI) {
    return false;
  }

  const plainOutput = stripAnsi(output);
  const tests = parseTestsSummary(plainOutput);
  if (tests === undefined || tests.failed > 0 || tests.passed === 0) {
    return false;
  }

  const headlines = collectHeadlineMessages(plainOutput);
  return headlines.length > 0
    && headlines.every((message) => BIRPC_NOISE_MESSAGE.test(message));
}

function stripAnsi(output) {
  return output.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
}

function parseTestsSummary(plainOutput) {
  const summary = TESTS_SUMMARY_LINE.exec(plainOutput);
  if (summary === null) {
    return undefined;
  }

  const counts = { failed: 0, passed: 0 };
  for (const segment of summary[1].split('|')) {
    const state = SUMMARY_STATE_SEGMENT.exec(segment.trim());
    if (state === null) {
      return undefined;
    }
    counts[state[2]] = Number(state[1]);
  }
  return counts;
}

function collectHeadlineMessages(plainOutput) {
  const messages = [];
  for (const line of plainOutput.split('\n')) {
    const headline = ERROR_HEADLINE.exec(line.trimEnd());
    if (headline !== null) {
      messages.push(headline[2]);
    }
  }
  return messages;
}
