import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digest } from '../providers/report-phase-handoff-model.mjs';
import { mergeRegradedComponents, readVerifiedTurn, selectReferenceContext, validateProtocol } from '../scripts/report-phase-handoff-regrade.mjs';

const protocol = JSON.parse(readFileSync(new URL('../cases/report-phase-handoff-grading-v2.json', import.meta.url), 'utf8'));

test('v2 restricts regrading to the two reviewed metrics without target generation', () => {
  assert.equal(validateProtocol(protocol), protocol);
  assert.throws(() => validateProtocol({ ...protocol, targetGeneration: true }));
  assert.throws(() => validateProtocol({ ...protocol, criteria: [protocol.criteria[0], protocol.criteria[0]] }));
  assert.throws(() => validateProtocol({ ...protocol, criteria: [...protocol.criteria, { ...protocol.criteria[0], metric: 'idless-source' }] }));
});

test('a stored response, prompt or trace mutation is rejected before regrading', () => {
  const directory = mkdtempSync(join(tmpdir(), 'report-regrade-hashes-'));
  try {
    const prefix = join(directory, 'phase2');
    const output = 'LABEL-01 was Verified';
    const prompt = 'Actual frozen report instruction';
    const trace = { responseHash: digest(output), promptHash: digest(prompt), startedFresh: true };
    const reset = () => {
      writeFileSync(prefix + '.output.md', output);
      writeFileSync(prefix + '.prompt.md', prompt);
      writeFileSync(prefix + '.trace.json', JSON.stringify(trace));
    };
    reset();
    assert.equal(readVerifiedTurn(prefix, trace).output, output);
    writeFileSync(prefix + '.output.md', 'A replacement report');
    assert.throws(() => readVerifiedTurn(prefix, trace), /response hash mismatch/);
    reset();
    writeFileSync(prefix + '.prompt.md', 'A replacement instruction');
    assert.throws(() => readVerifiedTurn(prefix, trace), /prompt hash mismatch/);
    reset();
    writeFileSync(prefix + '.trace.json', JSON.stringify({ ...trace, startedFresh: false }));
    assert.throws(() => readVerifiedTurn(prefix, trace), /trace differs/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('grader context uses the actual Phase 1 response and successful relevant receipts only', () => {
  const directory = mkdtempSync(join(tmpdir(), 'report-regrade-context-'));
  try {
    mkdirSync(join(directory, 'src'));
    mkdirSync(join(directory, 'tests'));
    writeFileSync(join(directory, 'src/session-label.js'), 'export function normalizeSessionLabel(label) {\n  return label.trim();\n}\n');
    writeFileSync(join(directory, 'tests/session-label.test.js'), 'test(\"preserves whitespace\", () => {});\n');
    const commands = [
      { command: 'cat .takt/policy.md', exitCode: 0, output: 'Unrelated policy material' },
      { command: 'rg --files src/session-label.js tests/session-label.test.js', exitCode: 0, output: 'Two filenames' },
      { command: 'nl -ba src/session-label.js', exitCode: 0, output: '1: function declaration\n2: trim' },
      { command: 'nl -ba tests/session-label.test.js', exitCode: 0, output: '1: real test' },
      { command: 'cat src/session-label.js', exitCode: 1, output: 'File read failed' },
      { command: 'npm run build', exitCode: 0, output: 'Syntax checked' },
      { command: 'npm test', exitCode: 0, output: 'Ready Now; Ready  Now; 2 passed' },
    ];
    const phase1 = { output: 'Actual response with an omitted line number', hashes: { response: 'recorded-response-hash' }, trace: { commands } };
    const context = selectReferenceContext({ upstream: 'LABEL-01 (Plan)' }, phase1, directory);
    assert.equal(context.actualPhase1FinalResponse, phase1.output);
    assert.match(context.purpose, /Never fill missing/);
    assert.match(context.immutableFixtureFiles[0].contentWithLines, /1: export function/);
    assert.match(context.immutableFixtureFiles[0].contentWithLines, /2:   return label.trim/);
    assert.equal(context.executedCommandReceipts.length, 4);
    assert.ok(context.executedCommandReceipts.every(receipt => receipt.exitCode === 0));
    assert.ok(context.executedCommandReceipts.every(receipt => !receipt.command.includes('policy') && !receipt.command.includes('--files')));
    assert.equal(phase1.output, 'Actual response with an omitted line number');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('regrading one metric preserves original source and precision failures', () => {
  const original = { components: [
    { metric: 'report-handoff/idless-source', pass: false, reason: 'Missing original source' },
    { metric: 'report-handoff/state-priority', pass: false, reason: 'Unsupported duplication requirement' },
  ] };
  const replacement = { metric: 'report-handoff/state-priority', pass: true, reason: 'Actual states and report evidence are correct' };
  const merged = mergeRegradedComponents(original, [replacement]);
  assert.equal(merged.status, 'model_failure');
  assert.equal(merged.components[0], original.components[0]);
  assert.equal(merged.components[1], replacement);
  assert.equal(original.components[1].pass, false);
  assert.throws(() => mergeRegradedComponents(original, [replacement, replacement]));
  assert.throws(() => mergeRegradedComponents(original, [{ ...replacement, metric: 'unknown-metric' }]));
});
