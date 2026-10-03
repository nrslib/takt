import { createHash } from 'node:crypto';
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { buildCodexSkillConfig } from '../../dist/infra/codex/skill-config.js';

export const digest = value => createHash('sha256').update(value).digest('hex');

export function auditSessionEvents(events, expected) {
  const contexts = events.filter(event => event.type === 'turn_context').map(event => event.payload);
  if (contexts.length === 0) throw new Error('Missing executed Codex turn context');
  for (const context of contexts) {
    if (context.model !== expected.model || context.effort !== expected.effort
      || context.sandbox_policy?.type !== 'read-only' || context.approval_policy !== 'never') {
      throw new Error('Executed Codex conditions differ from the frozen model/permissions');
    }
  }
  return { model: expected.model, effort: expected.effort, sandbox: 'read-only', approvalPolicy: 'never', observedTurnContexts: contexts.length };
}

export async function runReadOnlyModel({ prompt, cwd, model, effort, artifactPrefix, signal }) {
  const config = buildCodexSkillConfig({ cwd, env: process.env, inheritance: { repo: false, user: false } });
  const thread = new Codex({ config }).startThread({
    model, modelReasoningEffort: effort, workingDirectory: cwd,
    sandboxMode: 'read-only', approvalPolicy: 'never', skipGitRepoCheck: true,
    networkAccessEnabled: false, webSearchMode: 'disabled',
  });
  const startedFresh = thread.id === null;
  writeFileSync(`${artifactPrefix}.prompt.md`, prompt);
  const turn = await thread.run(prompt, { signal });
  if (typeof turn.finalResponse !== 'string' || turn.finalResponse.trim() === '') {
    throw new Error('SDK completed without a model response');
  }
  const sessionFiles = globSync(`**/*${thread.id}*.jsonl`, { cwd: join(homedir(), '.codex/sessions') });
  if (sessionFiles.length !== 1) throw new Error('Unable to uniquely locate executed Codex session for audit');
  const events = readFileSync(join(homedir(), '.codex/sessions', sessionFiles[0]), 'utf8')
    .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const runtime = auditSessionEvents(events, { model, effort });
  const tools = turn.items.filter(item => !['agent_message', 'reasoning', 'todo_list', 'error'].includes(item.type));
  const commands = tools.filter(item => item.type === 'command_execution').map(item => ({
    command: item.command, exitCode: item.exit_code, status: item.status, output: item.aggregated_output,
  }));
  // Deliberately omit thread/session IDs and raw session events from reviewable artifacts.
  const trace = {
    ...runtime, startedFresh, promptHash: digest(prompt), responseHash: digest(turn.finalResponse),
    networkAccessEnabled: false, webSearchMode: 'disabled',
    toolCount: tools.length, toolTypes: tools.map(item => item.type), commands,
    usage: turn.usage,
  };
  writeFileSync(`${artifactPrefix}.output.md`, turn.finalResponse);
  writeFileSync(`${artifactPrefix}.trace.json`, JSON.stringify(trace, null, 2) + '\n');
  writeFileSync(`${artifactPrefix}.private-turn.json`, JSON.stringify(turn, null, 2) + '\n', { mode: 0o600 });
  return { output: turn.finalResponse, trace };
}

export function scoreExecutionBoundary(sample, targetTrace, phase1Trace) {
  const failures = [];
  if (!targetTrace?.startedFresh) failures.push('Phase 2 was not a new session');
  if (targetTrace?.toolCount !== 0) failures.push('Phase 2 used tools');
  if (sample.kind === 'live-phase1-chain') {
    if (!phase1Trace?.startedFresh) failures.push('Phase 1 was not a new session');
    const commands = phase1Trace?.commands ?? [];
    for (const command of ['npm run build', 'npm test']) {
      if (!commands.some(receipt => receipt.command.includes(command) && receipt.exitCode === 0)) {
        failures.push('Phase 1 did not actually execute ' + command + ' successfully');
      }
    }
    const successfulReads = commands.filter(receipt => receipt.exitCode === 0 && /\b(?:cat|sed|nl|head|rg)\b/.test(receipt.command));
    for (const path of ['src/session-label.js', 'tests/session-label.test.js']) {
      if (!successfulReads.some(receipt => receipt.command.includes(path))) failures.push('Phase 1 did not inspect ' + path);
    }
    const evidence = commands.filter(receipt => receipt.exitCode === 0).map(receipt => receipt.output).join('\n');
    if (!evidence.includes('Ready Now') || !evidence.includes('Ready  Now')) failures.push('Missing successful concrete Phase 1 test observations');
  }
  return { pass: failures.length === 0, score: failures.length === 0 ? 1 : 0, reason: failures.join('; ') || 'Fresh tool-free Phase 2; actual Phase 1 receipts satisfy the chain contract' };
}
