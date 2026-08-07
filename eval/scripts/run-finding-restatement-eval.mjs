#!/usr/bin/env node
/**
 * Finding Contract restatement-prompt eval.
 *
 * Measures the metric that actually gates a restatement: does the reviewer come
 * back with a claim the engine can bind to the original anomaly?
 *
 * Pipeline per trial (mirrors production):
 *   1. reviewer model  <- restatement-only instruction (arm under test)
 *   2. real normalizer <- normalizeFindingIntake(report)   [dist, real template+schema]
 *   3. real gate       <- intakeContractDefectFor(candidate) + the restatement
 *                          correspondence clauses from reviewer-anomalies.ts
 *
 * Primary metric `accepted` = the raw would both clear the product-identity gate
 * AND satisfy hasRestatementCorrespondence, i.e. the anomaly would be promoted
 * and stop being re-presented.
 *
 * Usage:
 *   node eval/scripts/run-finding-restatement-eval.mjs \
 *     --arms baseline,a1-observation,a2-observation-form,a3-shipped-template --models glm,gemma
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { callOpenCodeCustom, resetSharedServer } from '../../dist/infra/opencode/client.js';
import { normalizeFindingIntake } from '../../dist/agents/finding-intake-normalizer-usecase.js';
import { intakeContractDefectFor } from '../../dist/core/workflow/findings/intake-contract.js';
import { buildFindingContractInstruction } from '../../dist/core/workflow/instruction/finding-contract-instruction.js';
import { renderTemplate } from '../../dist/shared/prompts/index.js';
import {
  computeRestatementRequestId,
  createFindingReviewPresentationContextV2,
} from '../../dist/core/workflow/findings/review-publication.js';
import { loadEvalSources } from './build-restatement-cases.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const evalDir = resolve(scriptDir, '..');
const caseDir = join(evalDir, 'cases', 'finding-restatement');
const workDir = join(evalDir, '.work', 'finding-restatement');
const isolationDir = join(tmpdir(), 'takt-finding-restatement');

const MODELS = {
  glm: { provider: 'opencode', model: 'ollama-cloud/glm-5.2' },
  gemma: { provider: 'opencode', model: 'ollama-cloud/gemma4:31b' },
};
// Normalizer is held constant across all arms so the comparison isolates the
// reviewer instruction. glm-5.2 is used because it is the cheapest candidate
// that supports isolated structured execution.
const NORMALIZER = { provider: 'opencode', model: 'ollama-cloud/glm-5.2' };

function readOption(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const armNames = String(readOption('--arms', 'baseline,shipped')).split(',');
const languages = String(readOption('--languages', 'ja')).split(',');
const modelNames = String(readOption('--models', 'glm,gemma')).split(',');
const caseLimit = Number.parseInt(readOption('--cases', '999'), 10);
const repeat = Number.parseInt(readOption('--repeat', '1'), 10);
const resultSet = readOption('--result-set', 'current');
const timeoutMs = Number.parseInt(readOption('--timeout-ms', '600000'), 10);
const concurrency = Number.parseInt(readOption('--concurrency', '5'), 10);

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- arms

function requestsJson(requests) {
  return ['```json', JSON.stringify(requests, null, 2), '```'].join('\n');
}

/**
 * Baseline renders the *pre-change* template snapshot through the same variable
 * set the engine uses, so it receives every common bullet the shipped arm gets
 * (severity/title statement, ledger ID rules, ...) and differs only in the
 * restatement block itself. Hand-writing just the restatement block would strip
 * bullets that production renders regardless of restatementOnly and inflate the
 * measured delta.
 */
function armBaseline(requests, language) {
  const raw = readFileSync(
    join(caseDir, 'baseline-prompt', language, 'finding_contract_instruction.md'),
    'utf8',
  );
  // Mirrors renderFindingContractInstruction's folded conditionals for a
  // restatement-only reviewer round (see finding-contract-instruction.ts).
  return renderTemplate(raw, {
    ledgerSummary: '```json\n[]\n```',
    isReportPhase: false,
    isReviewer: true,
    reviewerReportGuidance: false,
    reviewerHasOpenFindings: false,
    reviewerHasWaivedFindings: false,
    reviewerHasDismissedFindings: false,
    provisionalGuidance: false,
    restatementOnly: true,
    restatementRequestsJson: requestsJson(requests),
    canDispute: false,
  }).replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** Shared by the observation-only arms: the reviewer no longer authors
 *  severity / title / familyTag / relation (the normalizer proposes and the
 *  manager adjudicates those), so a restatement only has to reproduce the claim
 *  atom and put the evidence where the engine can verify it. */
const OBSERVATION_ONLY_RULES = [
  '- 分類は書かないでください。severity、title、family tag、lifecycle relation はあなたの担当ではありません。書いても採用されません。',
  '- あなたが書くのは「観察した事実」と「その根拠がある場所」の2つだけです。',
  '- **引用するファイルは必ず対象ファイルとして列挙してください。** evidence として行範囲を挙げたファイルが対象ファイル一覧に無いと、engine はその引用を対象と無関係とみなして棄却します。仕様書・テスト・比較用の別実装を根拠に挙げるなら、それらも対象ファイルに含めてください。',
  '- 行範囲は現在のファイルを実際に読んで 1-based で取ってください。engine が現物を読んで byte 一致を検証するため、ソース本文そのものは書かないでください。',
];

/** A1: observation-only restatement, verbatim claim atom, quote/target coupling.
 *  Template-only change. */
function armA1(requests) {
  return [
    '## Restatement requests',
    `これは再提示専用レビューです。下の ${requests.length} 件の request だけを処理してください。新しい調査も、新しい問題の報告も、承認判定もしないでください。`,
    '',
    '各 request について、次を守った観察をちょうど1件返してください。',
    '',
    '1. **claimedExcerpt をそのまま本文にする。** request の `claimedExcerpt` を1文字も変えずにコピーして観察本文としてください。engine は本文を claimedExcerpt と完全一致で照合し、一致しない観察は元の指摘と同一と判定できず、同じ指摘が別件として二重登録されます。要約・言い換え・行番号の追記・語句の補足・記号の変更はすべて不一致になります。文章として不自然でもそのままコピーしてください。',
    '2. **新しく判明した精度は本文ではなく evidence に置く。** 行番号が変わっていた、対象が増えていた等は evidence の path と行範囲で表現してください。本文は書き換えないでください。',
    '3. **`Reasserts Reviewer Anomaly ID` に request の anomalyId をそのまま1行で書く。**',
    '',
    ...OBSERVATION_ONLY_RULES,
    '- 現在のファイルが観察を裏づけない場合は、その request に対して何も返さず、その旨だけを書いてください。',
    requestsJson(requests),
  ].join('\n');
}

/** A2: A1 plus a per-request fill-in form rendered from the request instead of
 *  raw JSON, and an explicit "this response contains nothing else" scope line. */
function armA2(requests) {
  const lines = [
    '## Restatement requests',
    `これは再提示専用レビューです。下の ${requests.length} 件だけを処理してください。新しい調査も、新しい問題の報告も、承認判定も、チェック表の記入もしないでください。この応答には下の ${requests.length} 件の再提示エントリ以外を書かないでください。`,
    '',
    '### 返す形',
    '',
    '```markdown',
    '#### 再提示 <request の anomalyId>',
    '- **Reasserts Reviewer Anomaly ID**: `<request の anomalyId をそのまま>`',
    '- **対象ファイル**: `<path1>`, `<path2>` … （下の Evidence で引用する path をすべて列挙する）',
    '- **観察**: <request の claimedExcerpt を1文字も変えずにコピー>',
    '- **Evidence**: `<path>` の <開始行>-<終了行>（引用する箇所ごとに1行）',
    '```',
    '',
    '`観察` は engine が claimedExcerpt と完全一致で照合します。要約・言い換え・行番号の追記・語句の補足はすべて不一致になり、元の指摘と同一と判定できず、同じ指摘が別件として二重登録されます。文章として不自然でもそのままコピーしてください。新しく判明した精度は `観察` ではなく `Evidence` に置いてください。',
    '',
    ...OBSERVATION_ONLY_RULES,
    '- 現在のファイルが観察を裏づけない場合は、その request に対して何も返さず、その旨だけを書いてください。',
    '',
  ];
  for (const [i, r] of requests.entries()) {
    lines.push(`### Request ${i + 1} / ${requests.length}`);
    lines.push(`- anomalyId: \`${r.anomalyId}\``);
    lines.push(`- 前回の対象ファイル: ${r.targetPaths.length > 0 ? r.targetPaths.map((p) => `\`${p}\``).join(', ') : '(なし。現在のリポジトリから特定すること)'}`);
    lines.push('- そのままコピーする claimedExcerpt:');
    lines.push('');
    lines.push('```text');
    lines.push(r.claimedExcerpt);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The shipped arm renders the real engine block through
 * buildFindingContractInstruction, so it always measures exactly what
 * src/shared/prompts/{ja,en}/parts/finding_contract_instruction.md says. Both
 * languages come from the same call.
 */
function armShipped(requests, language) {
  const reviewer = requests[0]?.reviewer ?? 'security-review';
  const reviewScopeSnapshotId = requests[0]?.reviewScopeSnapshotId ?? '0'.repeat(64);
  return buildFindingContractInstruction({
    contract: {
      ledgerSummary: '[]',
      reportLedgerSummary: '[]',
      hasOpenFindings: false,
      hasWaivedFindings: false,
      hasDismissedFindings: false,
      reviewer: {
        reviewScopeSnapshotId,
        presentationContext: createFindingReviewPresentationContextV2({
          reviewScopeSnapshotId,
          restatementRequests: requests,
        }),
      },
    },
    language,
    renderFencedJsonBlock: (value) => ['```json', JSON.stringify(value, null, 2), '```'].join('\n'),
  }).replace(/^/, `<!-- reviewer: ${reviewer} -->\n`);
}

const ARMS = {
  baseline: (requests, language) => armBaseline(requests, language),
  'a1-observation': (requests) => armA1(requests),
  'a2-observation-form': (requests) => armA2(requests),
  shipped: (requests, language) => armShipped(requests, language),
};

// -------------------------------------------------- constant prompt scaffolding

/**
 * Production reviewers always receive their `*-finding-contract` output contract
 * alongside the engine block. Measuring without it hides exactly the failure the
 * adversarial review flagged: a restatement rule that contradicts the contract's
 * mandatory sections. Held constant across arms.
 */
function outputContractFormat(language) {
  return readFileSync(
    join(
      resolve(evalDir, '..'),
      'builtins', language,
      'facets/output-contracts/security-review-finding-contract.md',
    ),
    'utf8',
  );
}

const INTRO = {
  ja: [
    'あなたはコードレビュアーです。次の再提示要求に応答してください。',
    '通常の Markdown レビュー報告を返してください。JSON や structured output は返さないでください。',
  ].join('\n'),
  en: [
    'You are a code reviewer. Respond to the restatement requests below.',
    'Return an ordinary Markdown review report. Do not return JSON or structured output.',
  ].join('\n'),
};

/**
 * Case-independent fingerprint of an arm's wording, used as the prompt
 * generation key. Rendered against a fixed request so two cases of the same
 * generation share a digest and pool into one row.
 */
const CANONICAL_REQUEST = (() => {
  const withoutId = {
    anomalyId: 'RA-CANONICAL',
    reviewer: 'security-review',
    presentationOrdinal: 1,
    reviewScopeSnapshotId: '0'.repeat(64),
    sourceExcerptDigest: '1'.repeat(64),
    claimedExcerpt: 'A canonical claim atom.',
    targetPaths: ['src/example.ts'],
    missingRequirements: ['severity'],
    expectedRelation: 'new',
    expectedTargetFindingId: null,
    expectedTargetPreconditionClass: 'absent',
  };
  return [{ ...withoutId, restatementRequestId: computeRestatementRequestId(withoutId) }];
})();

const armDigestCache = new Map();
function armDigest(arm, language) {
  const key = `${arm}/${language}`;
  if (!armDigestCache.has(key)) {
    const body = [ARMS[arm](CANONICAL_REQUEST, language), outputContractFormat(language)].join('\n');
    armDigestCache.set(key, createHash('sha256').update(body).digest('hex').slice(0, 8));
  }
  return armDigestCache.get(key);
}

function buildPrompt(arm, requests, task, language) {
  return [
    INTRO[language],
    '',
    `## Task context\n${task}`,
    '',
    ARMS[arm](requests, language),
    '',
    language === 'ja' ? '## レポート書式（output contract）' : '## Report format (output contract)',
    outputContractFormat(language),
  ].join('\n');
}

// ---------------------------------------------------------------- scoring

function targetOf(candidate) {
  if (!candidate || candidate.target === null || candidate.target === undefined) {
    return { kind: 'review_scope' };
  }
  return candidate.target;
}

function scoreTrial({ testCase, candidates }) {
  const atom = norm(testCase.claimAtom);
  const result = {
    candidateCount: candidates.length,
    exactlyOneCandidate: candidates.length === 1,
    identityComplete: false,
    missingRequirements: null,
    shapeOk: false,
    atomVerbatim: false,
    atomSubstring: false,
    echoOk: false,
    echoExact: false,
    quoteTargetConsistent: false,
    accepted: false,
    bindable: false,
  };
  const c = candidates[0];
  if (!c) return result;

  const defect = intakeContractDefectFor({
    relation: c.relation ?? null,
    target: targetOf(c),
    familyTag: c.familyTag ?? null,
    severity: c.severity ?? null,
    title: c.title ?? null,
    description: c.description ?? null,
    rawExcerpt: undefined,
    evidence: c.evidenceRequests ?? [],
    evidenceCoverageGaps: [],
    reviewer: testCase.reviewer,
    presentationLimit: testCase.presentationLimit,
    lifecycleIntent: false,
  });
  result.identityComplete = defect === undefined;
  result.missingRequirements = defect ? defect.missingRequirements : [];

  // hasRestatementCorrespondence, shape clause
  result.shapeOk = c.relation === 'new'
    && (!Array.isArray(c.targetFindingIds) || c.targetFindingIds.length === 0);

  // hasRestatementCorrespondence, claim-atom clause
  const desc = norm(c.description);
  result.atomVerbatim = desc.length > 0 && desc === atom;
  result.atomSubstring = desc.length > 0 && (desc.includes(atom) || atom.includes(desc));

  // hasValidRestatementEcho
  const echo = c.reassertsReviewerAnomalyId ?? undefined;
  result.echoExact = echo === testCase.anomalyId;
  result.echoOk = echo === undefined || result.echoExact;

  // issueFindingEvidenceRequests: file_quote must sit on the code target's paths
  const target = targetOf(c);
  const quotes = (c.evidenceRequests ?? []).filter((e) => e.kind === 'file_quote');
  result.quoteTargetConsistent = quotes.length === 0
    ? target.kind !== 'code'
    : target.kind === 'code' && quotes.every((q) => target.paths.includes(q.path));

  // Today's gate: product identity is the reviewer's responsibility.
  result.accepted = result.exactlyOneCandidate
    && result.identityComplete
    && result.shapeOk
    && result.atomVerbatim
    && result.echoOk
    && result.quoteTargetConsistent;

  // Observation-only gate: classification moves to the normalizer + manager, so
  // a restatement only has to be bindable back to its anomaly with verifiable
  // evidence. relation may be absent (the manager assigns it).
  result.bindable = result.exactlyOneCandidate
    && result.atomVerbatim
    && result.echoOk
    && result.quoteTargetConsistent
    && (c.relation === 'new' || c.relation === null || c.relation === undefined)
    && (!Array.isArray(c.targetFindingIds) || c.targetFindingIds.length === 0);
  return result;
}

// ---------------------------------------------------------------- runner

async function withTimeout(factory, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await factory(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function runReviewer(modelKey, prompt, repoRoot) {
  const cfg = MODELS[modelKey];
  const response = await withTimeout(
    (abortSignal) => callOpenCodeCustom('restatement-reviewer', prompt, '', {
      // Production reviewers read the real repository; a restatement without
      // file access degenerates into "I cannot verify, so I return no claim".
      cwd: repoRoot,
      model: cfg.model,
      permissionMode: 'readonly',
      allowedTools: ['read', 'grep', 'glob', 'list'],
      language: 'ja',
      interactionTimeoutMs: timeoutMs + 5_000,
      abortSignal,
    }),
    timeoutMs,
  );
  return response.content ?? response.output ?? '';
}

async function runNormalizer(report) {
  const response = await withTimeout(
    (abortSignal) => normalizeFindingIntake(report, {
      provider: NORMALIZER.provider,
      model: NORMALIZER.model,
      language: 'ja',
      mode: 'initial',
      abortSignal,
    }),
    timeoutMs,
  );
  const out = response.structuredOutput;
  if (!out || !Array.isArray(out.rawFindings)) return [];
  return out.rawFindings.map((r) => r.candidate).filter(Boolean);
}

async function main() {
  mkdirSync(isolationDir, { recursive: true });
  const resultDir = join(workDir, 'results', resultSet);
  mkdirSync(resultDir, { recursive: true });

  const { cases } = JSON.parse(
    readFileSync(join(caseDir, 'real-intake-anomalies.cases.json'), 'utf8'),
  );
  // Cases carry only a sourceKey; the machine-local repo they cite is resolved
  // through the same sources file the case builder used.
  const repoRootByKey = new Map(loadEvalSources().map((s) => [s.key, s.repoRoot]));
  const selected = cases.slice(0, caseLimit);
  const trials = [];

  // Trial descriptors, then a fixed-size worker pool. Reviewer calls spend most
  // of their wall clock reading the repository, so serial execution is ~7min a
  // trial; production runs five reviewers concurrently against the same pool.
  const pending = [];
  for (const modelKey of modelNames) {
    for (const arm of armNames) {
      for (const language of languages) {
        for (const testCase of selected) {
          for (let rep = 0; rep < repeat; rep += 1) {
            pending.push({ modelKey, arm, language, testCase, rep });
          }
        }
      }
    }
  }

  async function runOne({ modelKey, arm, language, testCase, rep }) {
    const requestWithoutId = {
      anomalyId: testCase.anomalyId,
      reviewer: testCase.reviewer,
      presentationOrdinal: 1,
      reviewScopeSnapshotId: '0'.repeat(64),
      sourceExcerptDigest: '1'.repeat(64),
      claimedExcerpt: testCase.claimAtom,
      targetPaths: testCase.targetPaths,
      missingRequirements: testCase.missingRequirements,
      expectedRelation: 'new',
      expectedTargetFindingId: null,
      expectedTargetPreconditionClass: 'absent',
    };
    const requests = [{
      ...requestWithoutId,
      restatementRequestId: computeRestatementRequestId(requestWithoutId),
    }];
    const prompt = buildPrompt(arm, requests, testCase.title, language);
    // Generation identity of the arm itself, not of this prompt: the arm is
    // rendered against a fixed synthetic request so the digest stays constant
    // across cases. Editing an arm's wording (or the shipped template it
    // renders) changes it and invalidates that arm's cached trials, while the
    // scorer can still pool all cases of one generation into a single row.
    const promptDigest = armDigest(arm, language);
    const trialId = `${modelKey}--${arm}-${language}--${testCase.caseId}--r${rep}--${promptDigest}`;
    const cachePath = join(resultDir, `${trialId}.json`);
    if (existsSync(cachePath)) {
      process.stdout.write(`. ${trialId} (cached)\n`);
      return JSON.parse(readFileSync(cachePath, 'utf8'));
    }
    const repoRoot = repoRootByKey.get(testCase.sourceKey);
    if (repoRoot === undefined) {
      throw new Error(`No repoRoot for source key "${testCase.sourceKey}"; check the eval sources file.`);
    }
    const shared = {
      trialId, modelKey, arm, language, promptDigest, caseId: testCase.caseId,
      source: testCase.sourceKey, missing: testCase.missingRequirements,
    };
    let record;
    try {
      const report = await runReviewer(modelKey, prompt, repoRoot);
      const candidates = await runNormalizer(report);
      record = {
        ...shared,
        reportChars: report.length,
        score: scoreTrial({ testCase, candidates }),
        report, candidates,
      };
    } catch (error) {
      record = {
        ...shared,
        error: String(error?.message ?? error),
        score: scoreTrial({ testCase, candidates: [] }),
      };
    }
    writeFileSync(cachePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    const s = record.score;
    process.stdout.write(
      `${s.bindable ? 'OK ' : '.. '}${trialId} `
      + `cand=${s.candidateCount} id=${s.identityComplete ? 'Y' : 'N'} `
      + `atom=${s.atomVerbatim ? 'Y' : s.atomSubstring ? '~' : 'N'} `
      + `quote=${s.quoteTargetConsistent ? 'Y' : 'N'} `
      + `echo=${s.echoExact ? 'Y' : s.echoOk ? '-' : 'N'}`
      + `${record.error ? ` ERROR ${record.error.slice(0, 60)}` : ''}\n`,
    );
    return record;
  }

  try {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= pending.length) return;
        trials.push(await runOne(pending[index]));
      }
    });
    await Promise.all(workers);
  } finally {
    try { await resetSharedServer(); } catch { /* pool already down */ }
  }

  // -------------------------------------------------------------- summary
  const key = (t) => `${t.modelKey}/${t.arm}-${t.language}`;
  const groups = new Map();
  for (const t of trials) {
    if (!groups.has(key(t))) groups.set(key(t), []);
    groups.get(key(t)).push(t);
  }
  const rows = [];
  for (const [k, ts] of groups) {
    const n = ts.length;
    const pct = (f) => `${((ts.filter(f).length / n) * 100).toFixed(0)}%`;
    // Some cases are genuinely stale: the repository moved on since the anomaly
    // was recorded, so "no claim" is the correct answer. Separate that from
    // "returned a claim the engine cannot bind".
    const withClaim = ts.filter((t) => t.score.candidateCount > 0);
    const pctOf = (subset, f) => (subset.length === 0
      ? 'n/a'
      : `${((subset.filter(f).length / subset.length) * 100).toFixed(0)}%`);
    rows.push({
      arm: k,
      n,
      bindable: pct((t) => t.score.bindable),
      accepted: pct((t) => t.score.accepted),
      noClaim: pct((t) => t.score.candidateCount === 0),
      atomVerbatim: pctOf(withClaim, (t) => t.score.atomVerbatim),
      quoteOk: pctOf(withClaim, (t) => t.score.quoteTargetConsistent),
      identityComplete: pctOf(withClaim, (t) => t.score.identityComplete),
      echoExact: pctOf(withClaim, (t) => t.score.echoExact),
      oneCandidate: pct((t) => t.score.exactlyOneCandidate),
      errors: ts.filter((t) => t.error).length,
    });
  }
  rows.sort((a, b) => (a.arm < b.arm ? -1 : 1));
  console.log('\n=== restatement acceptance ===');
  console.table(rows);
  writeFileSync(join(resultDir, 'summary.json'), `${JSON.stringify({ rows, trials: trials.map((t) => ({ ...t, report: undefined })) }, null, 2)}\n`, 'utf8');
  console.log(`\nartifacts: ${resultDir}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
