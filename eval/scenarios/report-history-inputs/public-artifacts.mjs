import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReceiptCommand } from '../../providers/report-phase-handoff-audit-v3.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const hash = value => createHash('sha256').update(value).digest('hex');
const roles = ['fix-plan', 'loop-monitor'];

function readFiles(directory, prefix = '') {
  if (directory === undefined || !existsSync(directory)) return new Map();
  const files = new Map();
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [path, content] of readFiles(directory, name)) files.set(path, content);
    } else if (entry.isFile()) files.set(name, readFileSync(join(directory, name), 'utf8'));
  }
  return files;
}

function publicText(text, source) {
  return text.replaceAll(resolve(source), '.')
    .replaceAll(repository, '<repository>')
    .replace(/\/Users\/[^\s/`"'<>]+/g, '<local-home>')
    .replace(/\/home\/[^\s/`"'<>]+/g, '<local-home>');
}

function comparison(output, versions) {
  const current = versions.find(version => version.version === 'current');
  const prior = versions.find(version => version.version === 'prior');
  if (!current || !prior || !output.includes(current.marker) || !output.includes(prior.marker)
    || !/CURRENT_TARGETS[^\n]*B/.test(output) || /CURRENT_TARGETS[^\n]*A/.test(output)
    || !/PROGRESS[^\n]*改善/.test(output)) return undefined;
  return { currentProof: current.marker, priorProof: prior.marker, currentTargets: 'B', progress: '改善' };
}

function readReceipts(trace, versions, source) {
  const receipts = [];
  for (const record of trace.commands) {
    if (record.exitCode !== 0 || record.status !== 'completed') continue;
    let segments;
    try { segments = parseReceiptCommand(record.command); }
    catch { continue; }
    const isReportRead = ({ words, following }) => ['cat', 'sed', 'nl', 'head', 'tail', 'rg', 'wc'].includes(words[0])
      && [null, ';', '&&'].includes(following)
      && !words.some(word => /(?:^|\/)\.(?:codex|agents)(?:\/|$)|AGENTS\.md|[$`]/.test(word))
      && words.slice(1).every(word => !word.includes('/') || versions.some(version =>
        resolve(version.cwd, word).startsWith(resolve(version.cwd, 'reports') + '/')));
    for (const version of versions) {
      const absolutePath = join(source, version.path);
      const reader = segments.find(segment => isReportRead(segment)
        && segment.words.slice(1).some(word => resolve(version.cwd, word) === absolutePath));
      if (reader === undefined) continue;
      const evidence = version.content.split(/\r?\n/).filter(line => line.includes(version.marker)
        && record.output.split(/\r?\n/).some(observed => observed.endsWith(line)));
      if (evidence.length === 0) continue;
      const commandExcerpt = !segments.every(isReportRead);
      let command = commandExcerpt
        ? reader.words.map(word => /^[\w./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`).join(' ')
        : record.command;
      for (const target of versions) command = command.replaceAll(join(source, target.path), relative(version.cwd, join(source, target.path)));
      command = publicText(command, source);
      if (command.includes('<local-home>') || command.includes('<repository>')) continue;
      receipts.push({ version: version.version, path: version.path, marker: version.marker,
        cwd: relative(source, version.cwd), command, exitCode: record.exitCode, status: record.status,
        commandExcerpt, recordedCommandHash: hash(record.command), exitCodeScope: 'recorded command',
        output: evidence.join('\n'), artifactHash: hash(version.content) });
    }
  }
  return receipts;
}

export function publishEvaluation(source, destination, execution) {
  const files = readFiles(source);
  const projected = new Map();
  const writeJson = (name, value) => projected.set(name, JSON.stringify(value, null, 2) + '\n');
  const versions = [];
  for (const [name, content] of files) {
    if (!name.startsWith('project/reports/') && !roles.some(role => name.startsWith(`${role}/project/reports/`))) continue;
    const safe = publicText(content, source);
    projected.set(name, safe);
    if (!/\/executions\/versions\/[^/]+\/[^/]+\.md$/.test(name)) continue;
    const marker = content.match(/\b(?:CURRENT|PRIOR)_PROOF=fixture-[\w-]+|\b(?:CURRENT|PRIOR)_[\w-]+/)?.[0];
    if (marker === undefined) continue;
    versions.push({ path: name, content: safe, marker, version: marker.startsWith('CURRENT') ? 'current' : 'prior',
      cwd: join(source, name.slice(0, name.indexOf('project/') + 'project'.length)) });
  }
  const originalSummary = files.has('summary.json') ? JSON.parse(files.get('summary.json')) : [];
  const summary = [];
  const verification = [];
  for (const role of roles) {
    const original = originalSummary.find(row => row.role === role);
    if (!original && !files.has(`${role}.invocation.json`)) continue;
    const roleVersions = versions.filter(version => !version.path.startsWith(roles.find(other => other !== role) + '/'));
    const output = files.get(`${role}.output.md`);
    const decision = output === undefined ? undefined : comparison(output, roleVersions);
    const traceFile = files.get(`${role}.trace.json`);
    const trace = traceFile === undefined ? undefined : JSON.parse(traceFile);
    const receipts = trace === undefined ? [] : readReceipts(trace, roleVersions, source);
    const pass = original?.pass === true && !execution.failed && decision !== undefined
      && ['current', 'prior'].every(version => receipts.some(receipt => receipt.version === version));
    for (const suffix of ['invocation.json', 'prompt.md']) {
      const name = `${role}.${suffix}`;
      if (files.has(name)) projected.set(name, publicText(files.get(name), source));
    }
    const publicOutput = decision === undefined ? 'Comparison evidence unavailable.\n'
      : `CURRENT_PROOF: ${decision.currentProof}\nPRIOR_PROOF: ${decision.priorProof}\nCURRENT_TARGETS: B\nPROGRESS: 改善\n`;
    if (output !== undefined) projected.set(`${role}.output.md`, publicOutput);
    if (trace !== undefined) {
      writeJson(`${role}.trace.json`, {
        model: trace.model, effort: trace.effort, sandbox: trace.sandbox, approvalPolicy: trace.approvalPolicy,
        observedTurnContexts: trace.observedTurnContexts, startedFresh: trace.startedFresh,
        networkAccessEnabled: trace.networkAccessEnabled, webSearchMode: trace.webSearchMode,
        executedPromptHash: trace.executedPromptHash ?? trace.promptHash,
        executedResponseHash: trace.executedResponseHash ?? trace.responseHash,
        promptHash: hash(projected.get(`${role}.prompt.md`)), responseHash: hash(publicOutput),
        commands: receipts, toolCount: trace.toolCount, toolTypes: trace.toolTypes,
      });
    }
    const auditName = `${role}.failure-audit.json`;
    if (files.has(auditName)) {
      const audit = JSON.parse(files.get(auditName));
      writeJson(auditName, { model: audit.model, effort: audit.effort, sandbox: audit.sandbox,
        approvalPolicy: audit.approvalPolicy, timeoutMs: audit.timeoutMs, result: audit.result,
        executedTurnContexts: audit.executedTurnContexts, observedToolCalls: audit.observedToolCalls,
        observedCompletedResponses: audit.observedCompletedResponses });
    }
    verification.push({ role, pass, receipts, ...(decision === undefined ? {} : decision) });
    summary.push({ role, pass, ...(!execution.isolated ? { originalPass: original?.originalPass ?? original?.pass ?? false } : {}),
      ...(original?.model === undefined ? {} : { model: original.model, effort: original.effort }),
      ...(pass ? { currentTargets: decision.currentTargets, progress: decision.progress, commands: receipts }
        : { error: execution.interrupted ? 'Evaluation interrupted' : 'Evaluation evidence incomplete' }) });
  }
  if (summary.length === 0) summary.push({ pass: false, error: execution.interrupted ? 'Evaluation interrupted' : 'Evaluation did not complete' });
  writeJson('summary.json', summary);
  if (files.has('receipt-verification.json') || verification.some(row => row.receipts.length > 0)) writeJson('receipt-verification.json', verification);
  mkdirSync(destination, { recursive: true });
  for (const [name, content] of projected) {
    const path = join(destination, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  writeJson('publication.json', { isolated: execution.isolated, historical: source !== undefined && !execution.isolated,
    files: Object.fromEntries([...projected].map(([name, content]) => [name, hash(content)])) });
  writeFileSync(join(destination, 'publication.json'), projected.get('publication.json'));
  return summary;
}
