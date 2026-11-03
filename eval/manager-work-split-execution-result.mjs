import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readExecutionEvidence(directory) {
  const trial = JSON.parse(readFileSync(join(directory, 'trial.json'), 'utf8'));
  const parseLines = (text) => text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const events = parseLines(readFileSync(join(directory, 'events.jsonl'), 'utf8'));
  const checksText = readFileSync(join(directory, 'checks.jsonl'), 'utf8');
  return { trial, events, checks: parseLines(checksText), checksText };
}

export function buildExecutionOutput(directory, { trial, events, checksText }) {
  const verification = trial.turns.find(({ label }) => label === 'verification');
  if (verification === undefined) throw new Error('Verification turn is missing');
  if (!Array.isArray(trial.before?.questions) || !Array.isArray(trial.after?.questions)) {
    throw new Error('Question snapshots are missing');
  }
  return {
    artifact_dir: directory,
    response: verification.response,
    workLog: trial.workLog,
    checks: checksText,
    mcpCalls: events.filter(({ type, turn }) => type === 'mcp_call' && turn === verification.index),
    questions: { before: trial.before.questions, after: trial.after.questions },
  };
}
