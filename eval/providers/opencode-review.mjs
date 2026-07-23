#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length < 3) {
  throw new Error(
    'Usage: opencode-review.mjs <provider/model> <fixture-dir> [--phase2=<phase2-prompt-path>] <phase1-prompt>',
  );
}
if (args[2]?.startsWith('--') && !args[2].startsWith('--phase2=')) {
  throw new Error(`Unrecognized option: ${args[2]}`);
}

const [model, fixturePath] = args;
const phase2Arg = args[2]?.startsWith('--phase2=') ? args[2] : undefined;
const phase2Path = phase2Arg?.slice('--phase2='.length);
const phase1Prompt = phase2Path === undefined ? args[2] : args[3];
if (!phase1Prompt || phase2Path === '') {
  throw new Error('OpenCode prompt eval provider is missing a required prompt');
}
const providerDir = dirname(fileURLToPath(import.meta.url));
const evalDir = resolve(providerDir, '..');
const fixtureDir = resolve(evalDir, fixturePath);
const OPENCODE_EVAL_TIMEOUT_MS = 10 * 60 * 1000;

function runOpenCode(runArgs, phase) {
  const result = spawnSync('opencode', runArgs, {
    cwd: fixtureDir,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: OPENCODE_EVAL_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });

  if (result.error) {
    throw new Error(`${phase} OpenCode invocation failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `${phase} OpenCode exited with status ${result.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  return result.stdout;
}

function parseJsonEvents(stdout, phase, options = {}) {
  const events = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${phase} emitted invalid JSON on line ${index + 1}`);
      }
    });

  if (events.length === 0) {
    throw new Error(`${phase} emitted no JSON events`);
  }

  const sessionIds = new Set();
  const texts = [];
  for (const event of events) {
    if (typeof event.sessionID !== 'string' || event.sessionID.length === 0) {
      throw new Error(`${phase} emitted an event without sessionID`);
    }
    sessionIds.add(event.sessionID);
    if (event.type === 'error') {
      const detail = event.error?.data?.message ?? event.error?.name;
      throw new Error(`${phase} emitted an error event${detail ? `: ${detail}` : ''}`);
    }
    if (options.forbidToolUse && event.type === 'tool_use') {
      throw new Error(`${phase} attempted a forbidden tool call`);
    }
    if (event.type === 'text' && typeof event.part?.text === 'string') {
      texts.push(event.part.text);
    }
  }

  if (sessionIds.size !== 1) {
    throw new Error(`${phase} emitted conflicting session IDs`);
  }
  const sessionId = [...sessionIds][0];
  if (options.expectedSessionId !== undefined && sessionId !== options.expectedSessionId) {
    throw new Error(`${phase} did not resume the Phase 1 session`);
  }

  return { sessionId, text: texts.join('\n').trim() };
}

if (phase2Path === undefined) {
  const output = runOpenCode(
    ['run', '-m', model, '--pure', phase1Prompt],
    'Single phase',
  );
  process.stdout.write(output);
} else {
  const phase1Output = runOpenCode(
    ['run', '-m', model, '--pure', '--format', 'json', phase1Prompt],
    'Phase 1',
  );
  const phase1 = parseJsonEvents(phase1Output, 'Phase 1');
  const phase2Prompt = readFileSync(resolve(evalDir, phase2Path), 'utf-8');
  const phase2Output = runOpenCode(
    ['run', '-m', model, '--pure', '--format', 'json', '--session', phase1.sessionId, phase2Prompt],
    'Phase 2',
  );
  const phase2 = parseJsonEvents(phase2Output, 'Phase 2', {
    expectedSessionId: phase1.sessionId,
    forbidToolUse: true,
  });
  if (phase2.text.length === 0) {
    throw new Error('Phase 2 emitted no report text');
  }
  process.stdout.write(`${phase2.text}\n`);
}
