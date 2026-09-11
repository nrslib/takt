import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadWorkflowFromFile } from '../../dist/infra/config/loaders/workflowLoader.js';
import { providers, runComparison } from './development-loop-eval.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function orderedSet(items) {
  return items.map(item => typeof item === 'string' ? item : JSON.stringify(
    Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))),
  )).sort();
}

export function scoreHandoffDecision(output, sample) {
  let actual;
  try {
    actual = JSON.parse(output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
  } catch {
    return { pass: false, reason: 'invalid_json' };
  }
  const fields = ['run', 'carry', 'acceptance'];
  if (!actual || !fields.every(field => Array.isArray(actual[field]))) {
    return { pass: false, reason: 'invalid_decision' };
  }
  if (!actual.run.every(command => typeof command === 'string')
    || !actual.carry.every(command => typeof command === 'string')
    || !actual.acceptance.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) {
    return { pass: false, reason: 'invalid_decision' };
  }
  const failed = fields.filter(field => JSON.stringify(orderedSet(actual[field]))
    !== JSON.stringify(orderedSet(sample.expected[field])));
  return { pass: failed.length === 0, reason: failed.length ? `wrong_${failed.join('_')}` : 'expected_decision', decision: actual };
}

export function scoreHandoffContent(output, sample) {
  const blocks = [...output.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length > 1) return { pass: false, reason: 'ambiguous_json_blocks' };
  return scoreHandoffDecision(blocks.length === 1 ? blocks[0][1] : output, sample);
}

function auditContent(outputDirectory) {
  const manifest = JSON.parse(readFileSync(join(outputDirectory, 'manifest.json'), 'utf8'));
  const rows = manifest.providers.flatMap(provider => manifest.samples.map(sample => {
    const source = `${provider.cli}-${sample.revision}-${sample.language}-${sample.id}.json`;
    const row = JSON.parse(readFileSync(join(outputDirectory, source), 'utf8'));
    const content = row.reason === 'provider_error'
      ? { pass: false, reason: 'provider_error' } : scoreHandoffContent(row.output, sample);
    return {
      source, provider: row.provider, revision: row.revision, language: row.language, id: row.id,
      formatAndDecisionPass: row.pass, initialReason: row.reason,
      contentPass: content.pass, contentReason: content.reason, decision: content.decision,
    };
  }));
  writeFileSync(join(outputDirectory, 'content-audit.json'), JSON.stringify(rows, null, 2));
  console.log(JSON.stringify({ passed: rows.filter(row => row.contentPass).length, total: rows.length }));
  if (rows.some(row => !row.contentPass)) process.exitCode = 1;
}

export function buildHandoffManifest(baselineRevision) {
  if (!/^[a-f0-9]{40}$/.test(baselineRevision)) throw new Error('Provide the full baseline commit SHA');
  const baselineRoot = mkdtempSync(join(tmpdir(), 'takt-handoff-baseline-'));
  const cwd = mkdtempSync(join(tmpdir(), 'takt-handoff-loader-'));
  try {
    const archive = execFileSync('git', ['archive', baselineRevision, 'builtins'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', baselineRoot], { input: archive });
    const source = readFileSync(join(repoRoot, 'eval/cases/development-handoff-decisions.yaml'), 'utf8');
    const samples = [];
    for (const revision of ['baseline', 'candidate']) {
      for (const language of ['ja', 'en']) {
        const resourceRoot = join(revision === 'baseline' ? baselineRoot : repoRoot, 'builtins', language);
        const workflow = loadWorkflowFromFile(join(resourceRoot, 'workflows/development-implement.yaml'), cwd, { resourceRoot });
        const step = workflow.steps.find(step => step.name === 'implement');
        if (typeof step?.instruction !== 'string') throw new Error('Missing implementation instruction');
        for (const test of parse(source)) {
          const instruction = step.instruction.replaceAll('{report:plan.md}', '(Provided in the fixed snapshot below)')
            .replaceAll('{report:test-report.md}', '(Provided in the fixed snapshot below)');
          const prompt = `This is a decision-only evaluation of the following implementation instruction. Do not use tools or execute commands. All relevant facts have been checked and are supplied in the fixed snapshot. Decide which checks to perform next and what to carry into the next report.\n\n${instruction}\n\n## Fixed snapshot\n${test.snapshot}\n\nFor this evaluation, return only JSON instead of the report headings: {"run":["commands to execute now"],"carry":["commands whose successful results can be carried forward"],"acceptance":[{"state":"...","operation":"...","time":"...","target":"...","expected":"..."}]}. Use the command names and structured criterion values from the supplied materials. Retain independent criteria as separate rows. Do not claim to have executed any command.`;
          samples.push({ ...test, revision, language, prompt, promptHash: createHash('sha256').update(prompt).digest('hex') });
        }
      }
    }
    return { baselineRevision, evaluation: 'instruction-only-handoff-decisions', casesHash: createHash('sha256').update(source).digest('hex'), providers, samples };
  } finally {
    rmSync(baselineRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 4 && process.argv[2] === '--audit-content') {
    auditContent(resolve(process.argv[3]));
  } else if (process.argv.length === 4 && /^[a-f0-9]{40}$/.test(process.argv[2])) {
    await runComparison(buildHandoffManifest(process.argv[2]), resolve(process.argv[3]), scoreHandoffDecision);
  } else {
    throw new Error('Usage: node eval/scripts/development-handoff-eval.mjs <baseline-sha> <output-directory>');
  }
}
