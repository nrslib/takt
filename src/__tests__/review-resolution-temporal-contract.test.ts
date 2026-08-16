import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveRefToContent } from '../infra/config/loaders/resource-resolver.js';

const LANGUAGES = ['en', 'ja'] as const;
type Language = (typeof LANGUAGES)[number];

const TEMPORAL_MARKERS = {
  en: {
    adjudicationStart: '**Temporal input/output boundary:**',
    adjudicationEnd: 'Populate the Invariant Register Carry-forward',
    adjudicationClauses: [
      /already exists when this step starts[\s\S]*existing adjudication history[\s\S]*same file is this step's output destination/u,
      /not a finding submission source for this adjudication/u,
      /only findings submitted by the latest reviewer reports from the review round completed immediately before this step/u,
      /existing `review-resolution\.md` only to compare family identity, recorded dispositions, and Invariant Register Carry-forward/u,
      /not treat it as a new finding source[\s\S]*recreate an actionable finding solely because it is recorded there/u,
      /latest reviewer reports all say `APPROVE` and contain no `new`, `persists`, or `reopened` finding[\s\S]*this adjudication as having no actionable finding submission[\s\S]*Do not recreate any actionable family recorded in the existing `review-resolution\.md`[\s\S]*a report outside that review round/u,
      /family or finding recorded in the existing `review-resolution\.md` may enter the current actionable set only if one of those latest reviewer reports submits a current `new`, `persists`, or `reopened` finding with current evidence/u,
    ],
    adjudicationForbidden: [/\b(?:previous|prior|earlier|old)\b/u, /`review-adjudication`|`final-gate`/u],
    loopStart: 'If the latest reviewer reports from the immediately preceding completed review round all say `APPROVE`',
    loopEnd: 'Choose an outcome that does not retry the same review/fix work',
    loopClauses: [
      /latest reviewer reports from the immediately preceding completed review round all say `APPROVE` and contain no `new`, `persists`, or `reopened` finding/u,
      /same actionable family appears only in the `review-resolution\.md` currently present in the Report Directory/u,
      /`fix-verification\.md` for the repeated fix includes that family and records the result as `verified`[\s\S]*not treat the repetition as a normal stall that another review or fix can resolve/u,
      /current loop monitor's declared outcome for a loop that another review or fix cannot resolve[\s\S]*do not choose an outcome that directly retries reviewers or the same fix work/u,
    ],
    loopForbidden: [/Temporal input inconsistency|temporal-input inconsistency|\b(?:previous|prior|earlier|old|stale)\b/u],
  },
  ja: {
    adjudicationStart: '**入力と出力の時系列境界:**',
    adjudicationEnd: 'review-resolution.md の「再発台帳の引き継ぎ」',
    adjudicationClauses: [
      /この step の開始時点で既に存在する `review-resolution\.md` は既存の裁定履歴[\s\S]*同じファイルがこの step の出力先/u,
      /今回の finding の提出元ではありません/u,
      /この step の直前に完了した review ラウンドの最新 reviewer reports が提出した finding だけです/u,
      /既存の `review-resolution\.md` は、family 同一性、記録済み disposition、および「再発台帳の引き継ぎ」の照合だけに使ってください/u,
      /新しい finding の提出元として扱わず[\s\S]*そこに記録されていることだけを根拠に actionable finding を再生成しないでください/u,
      /最新 reviewer reports が全件 `APPROVE` で、`new`、`persists`、`reopened` が1件もない場合[\s\S]*この裁定には actionable finding の提出がないものとして扱ってください[\s\S]*現在のコードやその review ラウンド外のレポートが支持しているように見えても[\s\S]*既存の `review-resolution\.md` に記録された actionable family を再生成しないでください/u,
      /既存の `review-resolution\.md` に記録された family または finding を今回の actionable set に入れられるのは、その最新 reviewer reports のいずれかが、現在の証拠付きで `new`、`persists`、`reopened` の finding として提出した場合だけです/u,
    ],
    adjudicationForbidden: [/前回|以前|古い|実行開始時/u, /`review-adjudication`|`final-gate`/u],
    loopStart: '直前に完了した review ラウンドの最新 reviewer reports が全件 `APPROVE`',
    loopEnd: '実装未完了または報告未収束',
    loopClauses: [
      /直前に完了した review ラウンドの最新 reviewer reports が全件 `APPROVE` で、`new`、`persists`、`reopened` がない/u,
      /同じ actionable family がその reviewer reports にはなく[\s\S]*Report Directory に現在存在する `review-resolution\.md` にだけ記録/u,
      /修正の再実行に対する `fix-verification\.md` がその family を対象に含み、結果を `verified` と記録[\s\S]*次のレビュー・修正で解消できる通常の停滞として扱わない/u,
      /別のレビューまたは同じ修正の再実行では解消できない場合に対応する、現在の loop monitor に宣言済みの選択肢[\s\S]*reviewers または同じ fix を直接再実行する選択肢は選ばないでください/u,
    ],
    loopForbidden: [/入力時系列の不整合|前回|以前|古い/u],
  },
} as const satisfies Record<Language, {
  adjudicationStart: string;
  adjudicationEnd: string;
  adjudicationClauses: readonly RegExp[];
  adjudicationForbidden: readonly RegExp[];
  loopStart: string;
  loopEnd: string;
  loopClauses: readonly RegExp[];
  loopForbidden: readonly RegExp[];
}>;

function instruction(name: string, language: Language, projectDir: string): string {
  const content = resolveRefToContent(name, undefined, projectDir, 'instructions', {
    projectDir,
    lang: language,
  });
  if (content === undefined) throw new Error(`Builtin instruction not found: ${language}/${name}`);
  return content;
}

function outputContract(name: string, language: Language, projectDir: string): string {
  const content = resolveRefToContent(name, undefined, projectDir, 'output-contracts', {
    projectDir,
    lang: language,
  });
  if (content === undefined) throw new Error(`Builtin output contract not found: ${language}/${name}`);
  return content;
}

function sectionBetween(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Instruction section not found: ${start} -> ${end}`);
  }
  return content.slice(startIndex, endIndex);
}

function assertOrderedClauses(section: string, clauses: readonly RegExp[]): void {
  let previousEnd = 0;
  for (const clause of clauses) {
    const match = clause.exec(section);
    expect(match, `Missing instruction clause: ${clause}`).not.toBeNull();
    expect(match!.index, `Instruction clauses are out of order: ${clause}`).toBeGreaterThanOrEqual(previousEnd);
    previousEnd = match!.index + match![0].length;
  }
}

describe('review-resolution temporal instruction contract', () => {
  const projectDirs = Object.fromEntries(LANGUAGES.map((language) => [
    language,
    mkdtempSync(join(tmpdir(), `takt-review-resolution-temporal-${language}-`)),
  ])) as Record<Language, string>;

  afterAll(() => {
    for (const projectDir of Object.values(projectDirs)) rmSync(projectDir, { recursive: true, force: true });
  });

  it.each(LANGUAGES)('keeps adjudication input/output boundaries explicit in %s', (language) => {
    const markers = TEMPORAL_MARKERS[language];
    const content = instruction('adjudicate-review-findings', language, projectDirs[language]);
    const section = sectionBetween(content, markers.adjudicationStart, markers.adjudicationEnd);

    assertOrderedClauses(section, markers.adjudicationClauses);
    for (const forbidden of markers.adjudicationForbidden) expect(section).not.toMatch(forbidden);
    expect(content.indexOf(markers.adjudicationStart)).toBeLessThan(content.indexOf(markers.adjudicationEnd));
  });

  it.each(LANGUAGES)('routes resolution-only repetition out of the review/fix cycle in %s', (language) => {
    const markers = TEMPORAL_MARKERS[language];
    const content = instruction('loop-monitor-reviewers-fix', language, projectDirs[language]);
    const section = sectionBetween(content, markers.loopStart, markers.loopEnd);

    assertOrderedClauses(section, markers.loopClauses);
    for (const forbidden of markers.loopForbidden) expect(section).not.toMatch(forbidden);
    expect(content).toContain(language === 'en'
      ? 'only when either implementation is incomplete or the report has not converged, and no available action can break the deadlock'
      : '実装未完了または報告未収束のいずれかで、かつ利用可能な打開手段がない場合');
  });

  it.each(LANGUAGES)('uses only the current actionable-family section for reviewer continuation in %s', (language) => {
    const selector = instruction('select-applicable-candidates', language, projectDirs[language]);
    const adjudicationContract = outputContract('review-decision', language, projectDirs[language]);
    const finalGateContract = outputContract('supervisor-validation', language, projectDirs[language]);

    if (language === 'en') {
      expect(selector).toMatch(/current `Actionable Families` section[\s\S]*Only that current section can establish an unresolved actionable finding for continuation/u);
      expect(selector).toMatch(/do not infer one from Invariant Register Carry-forward, Requirement Decision Grounds, Finding Dispositions, Re-evaluation of Prior Findings, or any history row/u);
      expect(selector).toMatch(/current `Actionable Families` section is absent or empty[\s\S]*no candidate selection/u);
      expect(adjudicationContract).toMatch(/`Actionable Families` is the only selector-facing source of the current unresolved actionable set[\s\S]*Never copy a row there solely from carry-forward, requirement grounds, finding dispositions, or history/u);
      expect(finalGateContract).toMatch(/`Actionable Families` is the only selector-facing source of the current unresolved actionable set[\s\S]*Include only families that support the current `REJECT`[\s\S]*never copy a row there solely from carry-forward, requirements fulfillment, prior-finding re-evaluation, finding dispositions, or history/u);
      return;
    }

    expect(selector).toMatch(/現在の「修正対象 family」セクション[\s\S]*継続選択の根拠にできる未解消の actionable finding は、現在の「修正対象 family」セクションだけ/u);
    expect(selector).toMatch(/「再発台帳の引き継ぎ」「要件の判定根拠」「指摘ごとの裁定」「前段 finding の再評価」または履歴行から推測しない/u);
    expect(selector).toMatch(/現在の「修正対象 family」セクションが存在しないか空なら[\s\S]*候補を選択しない/u);
    expect(adjudicationContract).toMatch(/「修正対象 family」は、selector が現在の未解消 actionable set を読む唯一の箇所[\s\S]*再発台帳の引き継ぎ、要件の判定根拠、指摘ごとの裁定、履歴だけを根拠に行を転記しない/u);
    expect(finalGateContract).toMatch(/「修正対象 family」は、selector が現在の未解消 actionable set を読む唯一の箇所[\s\S]*現在の `REJECT` を根拠付ける family だけを含め[\s\S]*再発台帳の引き継ぎ、要件充足チェック、前段 finding の再評価、指摘ごとの裁定、履歴だけを根拠に行を転記しない/u);
  });
});
