#!/usr/bin/env node
/**
 * Re-score cached restatement trials without calling any model.
 *
 * Splits the outcome by stage, which the live runner cannot do on its own:
 *   reviewerAtomVerbatim — the reviewer's Markdown report contains the claim
 *                          atom verbatim (reviewer stage succeeded)
 *   atomVerbatim         — the normalizer's candidate.description equals it
 *                          (normalizer preserved it)
 * A trial with reviewerAtomVerbatim && !atomVerbatim is a normalizer loss, not a
 * reviewer failure, and needs a different fix.
 *
 * Re-scoring is deterministic and makes no provider calls, so it doubles as a
 * free regression over the cached sweep: the shipped restatement template must
 * stay far ahead of the pre-change baseline.
 *
 * Reference measurement (2026-08, result-set `final`). Conditions: 10 real
 * intake anomalies, repeat=1, reviewer models {glm-5.2, gemma4:31b}, the real
 * `security-review-finding-contract` output contract included in every prompt,
 * both arms rendered through the engine's own template machinery (baseline from
 * the pre-change snapshot under cases/finding-restatement/baseline-prompt/).
 *
 *   baseline-ja  n=20   bindable  0%   accepted  0%   (glm   0% / gemma  0%)
 *   shipped-ja   n=20   bindable 60%   accepted 60%   (glm  50% / gemma 70%)
 *   shipped-en   n=10   bindable 80%   accepted 80%   (glm 100% / gemma 60%)
 *
 * shipped-en covers cases 1-5 only, so it is not directly comparable to the
 * 10-case ja rows; on the matched 5-case subset the two languages track each
 * other. Every row is keyed by prompt generation digest, so trials produced by
 * an older arm wording never blend into a newer row.
 *
 * Residual loss in the shipped arm is `no candidate` ~20% (some source claims
 * are genuinely stale, and the baseline shows 35%) and `one candidate` ~80%
 * (the normalizer occasionally extracts a second claim from the output
 * contract's other sections).
 *
 * Arms: baseline | a1-observation | a2-observation-form | shipped. A drop
 * toward the baseline means the verbatim claim-atom rule, the labelled response
 * shape, or the quote/target coupling rule was weakened in
 * src/shared/prompts/{ja,en}/parts/finding_contract_instruction.md. Not wired
 * into `npm test` because the cached artifacts under eval/.work are not checked
 * in; run it after a sweep.
 *
 * Usage: node eval/scripts/score-finding-restatement-eval.mjs [--result-set final]
 *        [--prompt-digest <8hex>]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const evalDir = resolve(scriptDir, '..');

function readOption(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const resultSet = readOption('--result-set', 'main');
// Cached trials from an older prompt generation carry a different promptDigest.
// Mixing generations in one row silently averages two different prompts, so the
// digest is part of every grouping key; --prompt-digest narrows to one.
const digestFilter = readOption('--prompt-digest', undefined);
const resultDir = join(evalDir, '.work', 'finding-restatement', 'results', resultSet);
const { cases } = JSON.parse(
  readFileSync(join(evalDir, 'cases', 'finding-restatement', 'real-intake-anomalies.cases.json'), 'utf8'),
);
const caseById = new Map(cases.map((c) => [c.caseId, c]));
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const trials = [];
for (const file of readdirSync(resultDir)) {
  if (!file.endsWith('.json') || file === 'summary.json') continue;
  const t = JSON.parse(readFileSync(join(resultDir, file), 'utf8'));
  // Trials written before promptDigest existed cannot be attributed to a
  // generation; label them so they never blend into a digest-tagged row.
  t.promptDigest = t.promptDigest ?? 'legacy';
  if (digestFilter !== undefined && t.promptDigest !== digestFilter) continue;
  const c = caseById.get(t.caseId);
  const atom = norm(c?.claimAtom);
  t.reviewerAtomVerbatim = atom.length > 0 && norm(t.report).includes(atom);
  t.normalizerLoss = t.reviewerAtomVerbatim && !t.score.atomVerbatim;
  trials.push(t);
}

function table(groupBy) {
  const groups = new Map();
  for (const t of trials) {
    const k = groupBy(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const rows = [];
  for (const [k, ts] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const n = ts.length;
    const pct = (f) => `${((ts.filter(f).length / n) * 100).toFixed(0)}% (${ts.filter(f).length}/${n})`;
    rows.push({
      group: k,
      n,
      'bindable (primary)': pct((t) => t.score.bindable),
      'accepted (today gate)': pct((t) => t.score.accepted),
      'reviewer wrote atom': pct((t) => t.reviewerAtomVerbatim),
      'normalizer kept atom': pct((t) => t.score.atomVerbatim),
      'normalizer LOST atom': pct((t) => t.normalizerLoss),
      'no candidate': pct((t) => t.score.candidateCount === 0),
      'quote ok': pct((t) => t.score.quoteTargetConsistent),
      'echo exact': pct((t) => t.score.echoExact),
    });
  }
  return rows;
}

/** Prompt generation is part of the identity of every row. */
const gen = (t) => `${t.arm}-${t.language ?? 'ja'}@${t.promptDigest}`;

console.log(`\n=== by arm x reviewer model (n=${trials.length}) ===`);
console.table(table((t) => `${t.modelKey} / ${gen(t)}`));
console.log('\n=== by arm (pooled over reviewer models) ===');
console.table(table(gen));
console.log('\n=== by case source (pooled over arms) ===');
console.table(table((t) => `${t.source}-sourced case`));
