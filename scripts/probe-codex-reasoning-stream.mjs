import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Codex } from '@openai/codex-sdk';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function usageText() {
  return [
    'Usage:',
    '  node scripts/probe-codex-reasoning-stream.mjs',
    '    --model <model>',
    '    --prompt <prompt>',
    '    --output <events.jsonl>',
    '    [--effort <effort>]',
    '    [--config <json-object>]',
    '    [--cwd <directory>]',
    '',
    'Example:',
    '  node scripts/probe-codex-reasoning-stream.mjs \\',
    '    --model gpt-5.6-luna --effort xhigh \\',
    '    --config \'{"model_reasoning_summary":"auto"}\' \\',
    '    --prompt \'長い推論を必要とする検証を実行する\' \\',
    '    --output .takt/probes/luna-xhigh-auto.jsonl',
  ].join('\n');
}

function parseArguments(argv) {
  const values = new Map();
  const allowedArguments = new Set(['model', 'prompt', 'output', 'effort', 'config', 'cwd']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      return { help: true };
    }
    if (!argument.startsWith('--')) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`);
    }
    const name = argument.slice(2);
    if (!allowedArguments.has(name)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    values.set(name, value);
    index += 1;
  }

  const model = values.get('model');
  const prompt = values.get('prompt');
  const output = values.get('output');
  if (model === undefined || prompt === undefined || output === undefined) {
    throw new Error('--model, --prompt, and --output are required');
  }

  const rawConfig = values.get('config') ?? '{}';
  let config;
  try {
    config = JSON.parse(rawConfig);
  } catch (error) {
    throw new Error(`--config must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(config)) {
    throw new Error('--config must be a JSON object');
  }

  return {
    help: false,
    model,
    prompt,
    output: resolve(output),
    cwd: resolve(values.get('cwd') ?? process.cwd()),
    effort: values.get('effort'),
    config,
  };
}

function roundMilliseconds(value) {
  return Math.round(value * 1000) / 1000;
}

function createEventRecorder() {
  return {
    sequence: 0,
    previousMonotonicMs: undefined,
    turnStartedMonotonicMs: undefined,
    turnCompletedMonotonicMs: undefined,
    maxEventGap: undefined,
    usage: undefined,
    status: 'running',
    error: undefined,
  };
}

function recordEvent(file, recorder, event) {
  const monotonicMs = performance.now();
  const gapMs = recorder.previousMonotonicMs === undefined
    ? undefined
    : monotonicMs - recorder.previousMonotonicMs;
  const previousEventType = recorder.previousEventType;
  if (
    gapMs !== undefined
    && recorder.turnStartedMonotonicMs !== undefined
    && (recorder.maxEventGap === undefined || gapMs > recorder.maxEventGap.gapMs)
  ) {
    recorder.maxEventGap = {
      gapMs,
      fromEventType: previousEventType,
      toEventType: event.type,
    };
  }

  const line = {
    sequence: recorder.sequence,
    wallClock: new Date().toISOString(),
    monotonicMs: roundMilliseconds(monotonicMs),
    ...(gapMs === undefined ? {} : { eventGapMs: roundMilliseconds(gapMs) }),
    event,
  };
  file.write(`${JSON.stringify(line)}\n`);

  if (event.type === 'turn.started') {
    recorder.turnStartedMonotonicMs = monotonicMs;
  }
  if (event.type === 'turn.completed') {
    recorder.turnCompletedMonotonicMs = monotonicMs;
    recorder.usage = isRecord(event.usage) ? event.usage : null;
    recorder.status = 'completed';
  }
  if (event.type === 'turn.failed') {
    recorder.status = 'failed';
    recorder.error = String(event.error?.message ?? 'Codex turn failed');
  }
  if (event.type === 'error') {
    recorder.status = 'error';
    recorder.error = typeof event.message === 'string' ? event.message : 'Codex stream error';
  }
  recorder.previousMonotonicMs = monotonicMs;
  recorder.previousEventType = event.type;
  recorder.sequence += 1;
}

function buildSummary(options, recorder, error) {
  const summaryError = error ?? recorder.error;
  const durationMs = recorder.turnStartedMonotonicMs === undefined
    || recorder.turnCompletedMonotonicMs === undefined
    ? null
    : recorder.turnCompletedMonotonicMs - recorder.turnStartedMonotonicMs;
  return {
    model: options.model,
    effort: options.effort ?? null,
    config: options.config,
    cwd: options.cwd,
    output: options.output,
    status: error === undefined ? recorder.status : 'error',
    eventCount: recorder.sequence,
    turnStarted: recorder.turnStartedMonotonicMs !== undefined,
    turnCompleted: recorder.turnCompletedMonotonicMs !== undefined,
    turnDurationMs: durationMs === null ? null : roundMilliseconds(durationMs),
    maxEventGapMs: recorder.maxEventGap === undefined
      ? null
      : roundMilliseconds(recorder.maxEventGap.gapMs),
    maxEventGap: recorder.maxEventGap === undefined ? null : {
      fromEventType: recorder.maxEventGap.fromEventType,
      toEventType: recorder.maxEventGap.toEventType,
    },
    usage: recorder.usage ?? null,
    ...(summaryError === undefined ? {} : { error: summaryError }),
  };
}

async function runProbe(options) {
  const config = {
    ...options.config,
    ...(options.effort === undefined ? {} : { model_reasoning_effort: options.effort }),
  };
  const probeOptions = { ...options, config };
  const codex = new Codex({ config });
  const thread = codex.startThread({
    model: options.model,
    workingDirectory: options.cwd,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
  });
  await mkdir(dirname(options.output), { recursive: true });
  const file = createWriteStream(options.output, { encoding: 'utf8' });
  const recorder = createEventRecorder();
  let streamError;
  const fileFinished = finished(file).catch((error) => {
    streamError ??= error instanceof Error ? error.message : String(error);
  });
  try {
    const { events } = await thread.runStreamed(options.prompt);
    for await (const event of events) {
      recordEvent(file, recorder, event);
    }
  } catch (error) {
    streamError = error instanceof Error ? error.message : String(error);
  } finally {
    file.end();
    await fileFinished;
  }

  const summary = buildSummary(probeOptions, recorder, streamError);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (streamError !== undefined || recorder.status !== 'completed') {
    process.exitCode = 1;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usageText()}\n`);
    return;
  }
  await runProbe(options);
}

export { parseArguments, runProbe };

if (
  process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usageText()}\n`);
    process.exitCode = 1;
  });
}
