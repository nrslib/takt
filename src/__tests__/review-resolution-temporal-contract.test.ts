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
    adjudicationEnd: '**Tasks:**',
    adjudicationClauses: [
      /`review-resolution\.md` is this step's output destination\./u,
      /already exists when this step starts[\s\S]*previous revision[\s\S]*earlier `review-adjudication` or `final-gate`[\s\S]*not a submission source/u,
      /only findings to adjudicate are those submitted by the latest reviewer reports from the immediately preceding review round/u,
      /previous `review-resolution\.md` only to compare family identity, duplicate\/disposition decisions, and Invariant Register Carry-forward/u,
      /not a new finding source[\s\S]*old actionable finding must not be regenerated from it alone/u,
      /latest reviewer reports all say `APPROVE` and contain no `new`, `persists`, or `reopened` finding[\s\S]*current round as having no actionable finding submission[\s\S]*Do not recreate any actionable family recorded in the previous resolution[\s\S]*the current code or an older report/u,
      /finding from a previous resolution may be actionable in this run only when a latest reviewer report submits it as `persists` or `reopened` with current evidence/u,
    ],
    loopStart: '**Temporal input inconsistency:**',
    loopEnd: 'Choose a stop outcome',
    loopClauses: [
      /latest reviewer reports show the findings resolved \(all `APPROVE`, with no `new`, `persists`, or `reopened`\)/u,
      /prior `review-resolution\.md` alone repeats the same actionable family and a verified fix has already been rerun/u,
      /condition takes precedence over the progress criteria above[\s\S]*not a normal stall that another review or fix can resolve/u,
      /No feasible action can satisfy the requirements` \/ `ABORT` outcome[\s\S]*do not route back to reviewers or fixes/u,
    ],
  },
  ja: {
    adjudicationStart: '**入力と出力の時系列境界:**',
    adjudicationEnd: '**やること:**',
    adjudicationClauses: [
      /`review-resolution\.md` はこの裁定の出力先です/u,
      /実行開始時に同名ファイルが既に存在するなら[\s\S]*前回の `review-adjudication` または `final-gate`[\s\S]*以前の revision[\s\S]*今回の finding の提出元ではありません/u,
      /今回の裁定対象は、この裁定の直前ラウンドで最新 reviewer reports が提出した finding だけです/u,
      /前回の `review-resolution\.md` は family 同一性、重複・disposition、および「再発台帳の引き継ぎ」の照合だけに使ってください/u,
      /新しい finding の提出元にはせず、旧 actionable をそれだけで再生成しないでください/u,
      /最新 reviewer reports が全件 `APPROVE` で、`new`、`persists`、`reopened` が1件もない場合[\s\S]*今回ラウンドには actionable な finding の提出がないものとして扱ってください[\s\S]*現在のコードや古いレポートが支持しているように見えても[\s\S]*前回 resolution に記録された actionable family を再生成しないでください/u,
      /前回 resolution の finding を今回 actionable にできるのは、最新 reviewer report が `persists` または `reopened` として現在の証拠付きで提出した場合だけです/u,
    ],
    loopStart: '**入力時系列の不整合:**',
    loopEnd: '実装未完了または報告未収束',
    loopClauses: [
      /最新 reviewer reports が指摘を解消済み（全件 `APPROVE` で、`new`、`persists`、`reopened` がない）/u,
      /以前の `review-resolution\.md` だけが同じ actionable family を繰り返し、検証済み修正（verified fix）がすでに再実行されている/u,
      /上の進捗判定よりこの条件を優先し[\s\S]*次のレビュー・修正で解消できる通常の停滞ではない/u,
      /「要件を満たす実現可能な打開手段がない」\/ `ABORT` を選び[\s\S]*reviewers や fix へ戻さないでください/u,
    ],
  },
} as const satisfies Record<Language, {
  adjudicationStart: string;
  adjudicationEnd: string;
  adjudicationClauses: readonly RegExp[];
  loopStart: string;
  loopEnd: string;
  loopClauses: readonly RegExp[];
}>;

function instruction(name: string, language: Language, projectDir: string): string {
  const content = resolveRefToContent(name, undefined, projectDir, 'instructions', {
    projectDir,
    lang: language,
  });
  if (content === undefined) throw new Error(`Builtin instruction not found: ${language}/${name}`);
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
    expect(content.indexOf(markers.adjudicationStart)).toBeLessThan(content.indexOf(markers.adjudicationEnd));
  });

  it.each(LANGUAGES)('routes stale-resolution repetition to the existing stop outcome in %s', (language) => {
    const markers = TEMPORAL_MARKERS[language];
    const content = instruction('loop-monitor-reviewers-fix', language, projectDirs[language]);
    const section = sectionBetween(content, markers.loopStart, markers.loopEnd);

    assertOrderedClauses(section, markers.loopClauses);
    expect(section).toMatch(language === 'en'
      ? /route back to reviewers or fixes because of the stale resolution/u
      : /古い裁定を理由に reviewers や fix へ戻さないでください/u);
    expect(content).toContain(language === 'en'
      ? 'temporal input inconsistency above is present'
      : '上記の入力時系列の不整合がある場合');
  });
});
