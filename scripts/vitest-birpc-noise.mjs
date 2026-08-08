// birpc's RPC deadline is a fixed 60s. Four unit shards plus fork workers on
// one developer machine can starve a worker's event loop past it, and vitest
// then exits non-zero while every test passed. `npm test` re-measures a shard
// exactly once when its output carries that shape and nothing else, so the
// gate reports what the machine measured instead of a scheduling artifact.
// CI runs one shard per runner and has no such contention: a timeout there is
// real, so it is never re-measured.
const BIRPC_NOISE_MESSAGE = /^\[vitest-worker\]: Timeout calling "onTaskUpdate"/;

// vitest prints every error it reports as `<ErrorName>: <message>` at column 0
// (`printErrorMessage`), so an unrecognized headline means the shard failed for
// a reason this rescue does not cover.
const ERROR_HEADLINE = /^((?:[A-Za-z_$][\w$]*)?(?:Error|Exception)|Unknown Error): (.*)$/;

const TESTS_SUMMARY_LINE = /^[ \t]*Tests[ \t]+(.+) \(\d+\)$/m;
const SUMMARY_STATE_SEGMENT = /^(\d+) (failed|passed|skipped|todo)$/;

export function isBirpcNoiseOnlyFailure({ output, isCI }) {
  if (isCI) {
    return false;
  }

  const plainOutput = stripAnsi(output);
  const tests = parseTestsSummary(plainOutput);
  if (tests === undefined || tests.failed > 0 || tests.passed === 0) {
    return false;
  }

  const errorMessages = collectErrorMessages(plainOutput);
  return errorMessages.length > 0
    && errorMessages.every((message) => BIRPC_NOISE_MESSAGE.test(message));
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

function collectErrorMessages(plainOutput) {
  const messages = [];
  for (const line of plainOutput.split('\n')) {
    const headline = ERROR_HEADLINE.exec(line.trimEnd());
    if (headline !== null) {
      messages.push(headline[2]);
    }
  }
  return messages;
}
