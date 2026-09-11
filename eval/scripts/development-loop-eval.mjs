import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { scoreTransition } from '../asserts/completion-routing.mjs';
import buildPrompt, { loadCompletionRoutingStep } from '../completion-routing-prompt.mjs';
import { createCliReviewSession, runProcess } from '../providers/cli-review.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const providers = [
  { cli: 'claude', model: 'claude-opus-5' },
  { cli: 'codex', model: 'gpt-6-astra', reasoning_effort: 'xhigh', disable_inherited_skills: true },
  { cli: 'kimi', model: 'kimi-code/k3' },
];

export function parseKimiAssistantOutput(jsonl) {
  const messages = [];
  for (const line of jsonl.split(/\r?\n/).filter(line => line.trim())) {
    const event = JSON.parse(line);
    if (event.role === 'meta') continue;
    if (event.role !== 'assistant' || typeof event.content !== 'string') {
      throw new Error('Unexpected Kimi event; expected assistant text');
    }
    messages.push(event.content);
  }
  if (messages.length === 0) throw new Error('Kimi returned no assistant text');
  return messages.join('');
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function prepareManifest(baselineRevision, casesPath) {
  const source = readFileSync(casesPath, 'utf8');
  const cases = parse(source);
  const ids = new Set();
  const samples = [];
  for (const test of cases) {
    if (!/^[a-z0-9-]+$/.test(test.id) || ids.has(test.id)) throw new Error('Invalid or duplicate case ID');
    ids.add(test.id);
    if (!['runtime-derived', 'held-out-domain', 'control'].includes(test.origin)) throw new Error('Unknown case origin');
    for (const revision of ['baseline', 'candidate']) {
      for (const language of ['ja', 'en']) {
        const vars = {
          workflow: test.workflow, report: test.report, language,
          ...(revision === 'baseline' ? { baseline_revision: baselineRevision } : {}),
        };
        const step = loadCompletionRoutingStep(vars);
        const prompt = buildPrompt({ vars });
        samples.push({ ...test, revision, language, step, prompt, promptHash: digest(prompt) });
      }
    }
  }
  return { baselineRevision, casesHash: digest(source), providers, samples };
}

async function callProvider(provider, prompt, abortSignal) {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-loop-eval-'));
  try {
    if (provider.cli === 'kimi') {
      const skillsDir = join(cwd, 'empty-skills');
      mkdirSync(skillsDir);
      const events = await runProcess('kimi', [
        '-m', provider.model, '--skills-dir', skillsDir,
        '--output-format', 'stream-json', '-p', prompt,
      ], { cwd, input: '', timeoutMs: 300000, abortSignal });
      return parseKimiAssistantOutput(events);
    }
    return await createCliReviewSession({ ...provider, timeout_ms: 300000 }, { cwd, abortSignal }).run(prompt);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export function summarize(rows) {
  return providers.flatMap(provider => ['baseline', 'candidate'].flatMap(revision =>
    ['runtime-derived', 'held-out-domain', 'control'].map(origin => {
      const matches = rows.filter(row => row.provider === provider.cli && row.revision === revision && row.origin === origin);
      return {
        provider: provider.cli, model: provider.model, revision, origin,
        passed: matches.filter(row => row.pass).length,
        total: matches.length,
        errors: matches.filter(row => row.reason === 'provider_error').length,
      };
    })));
}

export async function runComparison(manifest, outputDirectory, score) {
  const manifestText = JSON.stringify(manifest, null, 2);
  const manifestHash = digest(manifestText);
  mkdirSync(outputDirectory, { recursive: true });
  const manifestPath = join(outputDirectory, 'manifest.json');
  if (existsSync(manifestPath)) {
    if (readFileSync(manifestPath, 'utf8') !== manifestText) {
      throw new Error('Inputs changed: use a new output directory to preserve the earlier evaluation');
    }
  } else {
    writeFileSync(manifestPath, manifestText, { flag: 'wx' });
  }
  const rows = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    // Every baseline finishes before candidate calls begin. Both use frozen prompts and expectations.
    for (const revision of ['baseline', 'candidate']) {
      const outcomes = await Promise.allSettled(providers.map(async provider => {
        for (const sample of manifest.samples.filter(sample => sample.revision === revision)) {
          if (controller.signal.aborted) throw new Error('Evaluation aborted');
          const key = `${provider.cli}-${revision}-${sample.language}-${sample.id}`;
          const path = join(outputDirectory, `${key}.json`);
          if (existsSync(path)) {
            const prior = JSON.parse(readFileSync(path, 'utf8'));
            if (prior.manifestHash !== manifestHash) throw new Error('Saved result does not match manifest');
            if (prior.reason === 'provider_error') throw new Error(`${provider.cli} has a saved provider error; preserve it and use a new output directory`);
            rows.push({ ...prior, ...score(prior.output, sample) });
            continue;
          }
          const startedAt = new Date().toISOString();
          const start = Date.now();
          let response;
          try {
            const output = await callProvider(provider, sample.prompt, controller.signal);
            response = { output, ...score(output, sample) };
          } catch (error) {
            // Provider diagnostics can contain account identifiers; never print them with evaluation results.
            writeFileSync(join(outputDirectory, `${key}.private-error.txt`), String(error), { mode: 0o600, flag: 'wx' });
            response = { pass: false, reason: 'provider_error', transition: null };
          }
          const row = {
            manifestHash, provider: provider.cli, model: provider.model,
            id: sample.id, origin: sample.origin, revision, language: sample.language,
            expected: sample.expected, startedAt, durationMs: Date.now() - start, ...response,
          };
          writeFileSync(path, JSON.stringify(row, null, 2), { flag: 'wx' });
          rows.push(row);
          console.log(JSON.stringify({ key, pass: row.pass, transition: row.transition, reason: row.reason }));
          if (row.reason === 'provider_error') throw new Error(`${provider.cli} failed; private diagnostic saved`);
        }
      }));
      const rejected = outcomes.filter(outcome => outcome.status === 'rejected');
      if (rejected.length > 0) throw new Error(rejected.map(outcome => outcome.reason.message).join('\n'));
    }
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    writeFileSync(join(outputDirectory, 'scored-results.json'), JSON.stringify(rows, null, 2));
    writeFileSync(join(outputDirectory, 'summary.json'), JSON.stringify(summarize(rows), null, 2));
  }
  const summary = summarize(rows);
  console.log(JSON.stringify(summary, null, 2));
  if (rows.some(row => row.revision === 'candidate' && !row.pass)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 4 || process.argv.length > 5) {
    throw new Error('Usage: node eval/scripts/development-loop-eval.mjs <baseline-sha> <output-directory> [cases-file]');
  }
  if (!/^[a-f0-9]{40}$/.test(process.argv[2])) throw new Error('Provide the full baseline commit SHA');
  const casesPath = process.argv[4] === undefined
    ? join(repoRoot, 'eval/cases/development-loop-handoffs.yaml') : resolve(process.argv[4]);
  await runComparison(prepareManifest(process.argv[2], casesPath), resolve(process.argv[3]),
    (output, sample) => scoreTransition(output, sample.step, sample.expected));
}
