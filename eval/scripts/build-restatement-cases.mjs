#!/usr/bin/env node
/**
 * Extract restatement eval cases from real Finding Contract run ledgers.
 *
 * Each case is one real `intake-contract-incomplete` reviewer anomaly: the claim
 * atom the engine will demand back verbatim, the missing product-identity
 * requirements, and the target paths.
 *
 * Source runs are machine-local, so they are NOT hard-coded here. Point
 * TAKT_RESTATEMENT_EVAL_SOURCES at a JSON file (default:
 * eval/.work/finding-restatement/sources.json, which is not checked in):
 *
 *   { "sources": [
 *       { "key": "glm",   "reviewerModel": "ollama-cloud/glm-5.2",
 *         "runsRoot": "/abs/path/.takt/runs", "repoRoot": "/abs/path" }
 *   ] }
 *
 * The emitted cases carry only `sourceKey`; the runner resolves it back to a
 * repoRoot through the same file, so the checked-in case fixture stays free of
 * machine-specific paths.
 *
 * Read-only with respect to the source runs.
 */
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const evalDir = resolve(scriptDir, '..');
const outDir = join(evalDir, 'cases', 'finding-restatement');

export const DEFAULT_SOURCES_PATH = join(
  evalDir, '.work', 'finding-restatement', 'sources.json',
);

export function loadEvalSources() {
  const path = process.env.TAKT_RESTATEMENT_EVAL_SOURCES ?? DEFAULT_SOURCES_PATH;
  if (!existsSync(path)) {
    throw new Error(
      `Restatement eval sources not found at ${path}. Create it (or set `
      + 'TAKT_RESTATEMENT_EVAL_SOURCES) with {"sources":[{"key","reviewerModel","runsRoot","repoRoot"}]}.',
    );
  }
  const { sources } = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error(`${path} declares no sources`);
  }
  return sources;
}

function latestLedger(runsRoot, sourceKey) {
  const candidates = readdirSync(runsRoot)
    .sort()
    .map((d) => join(runsRoot, d, 'reports', 'findings-ledger.json'))
    .filter((p) => existsSync(p));
  const latest = candidates[candidates.length - 1];
  if (latest === undefined) {
    throw new Error(
      `Source "${sourceKey}" has no reports/findings-ledger.json under any run in ${runsRoot}. `
      + 'Point runsRoot at a .takt/runs directory that contains at least one finished FC run.',
    );
  }
  return latest;
}

/**
 * When intake never produced a usable title, createReviewerAnomalySpec falls back
 * to `Reviewer evidence anomaly <rawFindingId>` — and a raw finding id embeds the
 * run id plus the whole workflow stack as JSON. Feeding that into the eval's task
 * context buries the real subject under workflow digests and weakens the signal
 * the arms are being compared on, so substitute the claim atom instead.
 */
const MACHINE_GENERATED_TITLE = /^Reviewer evidence anomaly /u;

export function taskContextTitle(title, claimAtom) {
  if (typeof title !== 'string' || MACHINE_GENERATED_TITLE.test(title)) {
    return claimAtom.slice(0, 200);
  }
  return title;
}

async function main() {
  const perSource = Number.parseInt(process.argv[2] ?? '5', 10);
  // Production selects the presented claim atom through
  // boundedRestatementClaimExcerpt; the eval must show the reviewer the same
  // string, otherwise it measures a request shape that never ships.
  const { boundedRestatementClaimExcerpt } = await import(
    '../../dist/core/workflow/engine/WorkflowEngineSetup.js'
  );

  const cases = [];
  for (const source of loadEvalSources()) {
    const ledger = JSON.parse(readFileSync(latestLedger(source.runsRoot, source.key), 'utf8'));
    const rawById = new Map(ledger.rawFindings.map((r) => [r.rawFindingId, r]));
    const anomalies = ledger.reviewerAnomalies.filter((a) => a.kind === 'intake-contract-incomplete');

    const seenCombo = new Set();
    const ordered = [...anomalies].sort((a, b) => {
      const ka = (a.intakeContract.missingRequirements ?? []).join('+');
      const kb = (b.intakeContract.missingRequirements ?? []).join('+');
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    const picked = [];
    for (const pass of [0, 1]) {
      for (const a of ordered) {
        if (picked.length >= perSource) break;
        const sourceRaw = (a.sourceRawFindingIds ?? []).map((id) => rawById.get(id)).find(Boolean);
        if (!sourceRaw) continue;
        const combo = (a.intakeContract.missingRequirements ?? []).join('+');
        if (pass === 0 && seenCombo.has(combo)) continue;
        if (picked.some((p) => p.anomalyId === a.id)) continue;
        seenCombo.add(combo);
        const claimAtom = boundedRestatementClaimExcerpt(a, sourceRaw);
        if (!claimAtom || claimAtom.trim().length === 0) continue;
        const targetPaths = sourceRaw.target?.kind === 'code'
          ? [...new Set(sourceRaw.target.paths)].sort()
          : [];
        picked.push({
          caseId: `${source.key}-${a.id}`,
          sourceKey: source.key,
          reviewerModel: source.reviewerModel,
          anomalyId: a.id,
          reviewer: a.intakeContract.presentationOwnerReviewer,
          missingRequirements: [...(a.intakeContract.missingRequirements ?? [])].sort(),
          presentationLimit: a.intakeContract.presentationLimit,
          title: taskContextTitle(a.title, claimAtom),
          claimAtom,
          targetPaths,
          sourceFileQuotes: (sourceRaw.evidence ?? [])
            .filter((e) => e.kind === 'file_quote')
            .map((e) => ({ path: e.path, startLine: e.startLine, endLine: e.endLine })),
        });
      }
    }
    cases.push(...picked);
  }

  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'real-intake-anomalies.cases.json');
  writeFileSync(outPath, `${JSON.stringify({ cases }, null, 2)}\n`, 'utf8');
  console.log(`wrote ${cases.length} cases -> ${outPath}`);
  for (const c of cases) {
    console.log(` ${c.caseId} reviewer=${c.reviewer} missing=[${c.missingRequirements}] atomChars=${c.claimAtom.length} paths=${c.targetPaths.length} quotes=${c.sourceFileQuotes.length}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
