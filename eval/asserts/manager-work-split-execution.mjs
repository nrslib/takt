import { buildExecutionOutput, readExecutionEvidence } from '../manager-work-split-execution-result.mjs';

const result = (pass, reason) => ({ pass, score: pass ? 1 : 0, reason });

function shellCommands(command) {
  const commands = [[]];
  let word = '';
  let wordStarted = false;
  let quote = '';
  const finishWord = () => {
    if (wordStarted) commands.at(-1).push(word);
    word = '';
    wordStarted = false;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === '\\' && quote !== "'" && index + 1 < command.length) {
      word += command[++index];
      wordStarted = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      wordStarted = true;
    } else if (char === '\n' || char === ';' || char === '|' || char === '&' && command[index + 1] === '&') {
      finishWord();
      commands.push([]);
      if ((char === '|' || char === '&') && command[index + 1] === char) index++;
    } else if (/\s/u.test(char)) {
      finishWord();
    } else {
      word += char;
      wordStarted = true;
    }
  }
  finishWord();
  return commands;
}

function attemptsCommitProducingGitOperation(command) {
  return shellCommands(command).some((args) => {
    if (args[0] !== 'git') return false;
    let index = 1;
    while (args[index]?.startsWith('-')) {
      const option = args[index];
      index += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(option) ? 2 : 1;
    }
    return ['commit', 'merge', 'cherry-pick'].includes(args[index]);
  });
}

export function gradeExecution(trial, events, checks) {
  if (!trial.complete || !trial.cleaned || trial.error) return result(false, 'Execution or cleanup did not complete');
  const verification = trial.turns.find(({ label }) => label === 'verification');
  if (!verification?.response?.message || verification.response.summary !== null
    || verification.timedOut || !verification.finishedAt) return result(false, 'Verification did not return normally for the existing goal');
  if (trial.case === 'integrated-task-execution') {
    if (!Array.isArray(trial.before?.questions) || !Array.isArray(trial.after?.questions)) return result(false, 'Question snapshots are missing');
    const existingApprovals = new Set(trial.before.questions.filter(({ kind }) => kind === 'approval').map(({ id }) => id));
    if (trial.after.questions.some(({ id, kind }) => kind === 'approval' && !existingApprovals.has(id))) {
      return result(false, 'An approval inquiry was created');
    }
  }
  const { refs: beforeRefs, ...beforeGit } = trial.before.git;
  const { refs: afterRefs, ...afterGit } = trial.after.git;
  if (JSON.stringify(beforeGit) !== JSON.stringify(afterGit)
    || !beforeRefs.split('\n').every((line) => afterRefs.split('\n').includes(line))) return result(false, 'Git objects, existing refs or caller checkout changed');
  if (trial.case === 'integrated-task-execution' && trial.denials.some(({ turn }) => turn === verification.index)) return result(false, 'Permission denial or approval request occurred');
  const calls = events.filter(({ type, turn }) => type === 'tool_use' && turn === verification.index);
  const commands = calls.filter(({ data }) => data.tool === 'Bash').map(({ data }) => data.input.command);
  // Attempts matter even if permission denied them or the branch was later restored.
  if (commands.some(attemptsCommitProducingGitOperation)) return result(false, 'Verification attempted a commit-producing Git operation');
  const logs = trial.workLog.filter(({ turn }) => turn === verification.index);
  if (logs.length === 0) return result(false, 'No saved verification record');
  if (trial.case === 'stopped-background-execution') {
    if (!trial.background?.started || !trial.background.stopped || !trial.background.reaped) return result(false, 'Background lifecycle evidence missing');
    if (!trial.turns.some(({ label, response, finishedAt }) => label === 'predecessor' && response?.message && finishedAt)) return result(false, 'Predecessor turn missing');
    if (!trial.turns.some(({ label, response, finishedAt }) => label === 'followup' && response?.message && finishedAt)) return result(false, 'Same executor did not accept the next input');
    if (commands.some((command) => /\b(?:until|while)\b[\s\S]*\bsleep\b/u.test(command))) return result(false, 'Polling was selected for the previous background check');
    if (checks.length === 0) {
      return result(true, 'Returned without polling; the saved record and response require semantic grading as unconfirmed');
    }
  } else if (trial.case !== 'integrated-task-execution') return result(false, 'Unknown execution case');
  const starts = checks.filter(({ kind, at }) => kind === 'start' && at >= verification.startedAt);
  const ends = checks.filter(({ kind, at }) => kind === 'end' && at >= verification.startedAt);
  if (starts.length === 0 || starts.length !== ends.length) return result(false, 'Test was not completed');
  if (starts.some((start) => start.head !== trial.goalSha || start.cwd === trial.cwd
    || !ends.some((end) => end.run === start.run && end.head === start.head && end.cwd === start.cwd && end.code === 0
      && end.at <= verification.finishedAt))) return result(false, 'Check did not finish on the goal tip in a temporary workspace');
  return result(true, 'Observed completed check without new commits or approval records; question contents require semantic grading');
}

export default function assertExecution(output, context) {
  try {
    const payload = JSON.parse(output);
    const directory = payload.artifact_dir;
    const evidence = readExecutionEvidence(directory);
    const { trial, events, checks } = evidence;
    if (trial.case !== context.vars.case || trial.lang !== context.vars.lang) return result(false, 'Wrong trial identity');
    const expected = buildExecutionOutput(directory, evidence);
    if (JSON.stringify(payload.mcpCalls) !== JSON.stringify(expected.mcpCalls)
      || JSON.stringify(payload.questions) !== JSON.stringify(expected.questions)) {
      return result(false, 'Question evidence is missing or differs from saved artifacts');
    }
    return gradeExecution(trial, events, checks);
  } catch (error) { return result(false, `Missing or invalid execution evidence: ${error.message}`); }
}
