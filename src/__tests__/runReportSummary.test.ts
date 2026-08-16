import { describe, expect, it } from 'vitest';
import {
  formatRunReportSummary,
  summarizeRunReports,
} from '../features/tasks/list/runReportSummary.js';

function supervisorValidation(
  requirement: string,
  status: string,
  gate: string = '',
  additionalRequirementRows: readonly string[] = [],
): string {
  return [
    '# 最終検証結果',
    '',
    '## 要件充足チェック',
    '| # | 分解した要件 | 元要件の出典 | 充足 | 根拠 |',
    '|---|---|---|---|---|',
    `| 1 | ${requirement} | order.md | ${status} | 実行結果 |`,
    ...additionalRequirementRows,
    '',
    '## 前段 finding の再評価',
    '| finding ID / 出典 | 元の受入条件 | 解消状態 | 根拠 |',
    '|---|---|---|---|',
    '| FINDING-1 | 条件 | 未解消 | 継続 |',
    '',
    '## 判定不能の理由（BLOCKED の場合）',
    ...(gate.length > 0 ? [`- ${gate}`] : []),
  ].join('\n');
}

function reviewDecision(
  requirement: string,
  requirementStatus: string,
  findingStatus: string,
  history: string,
): string {
  return [
    '# Review decision',
    '',
    '## Requirement Decision Grounds',
    '| Subject | Status | Grounds |',
    '|---|---|---|',
    `| ${requirement} | ${requirementStatus} | verified |`,
    '',
    '## Finding Dispositions',
    '| Finding ID / Source | Disposition | Basis |',
    '|---|---|---|',
    `| FINDING-1 | ${findingStatus} | ${history} |`,
    '',
    '## Re-evaluation of Prior Findings',
    `- ${history}`,
  ].join('\n');
}

function reviewDecisionJa(
  requirement: string,
  requirementStatus: string,
  findingStatus: string,
): string {
  return [
    '# レビュー指摘裁定',
    '',
    '## 要件の判定根拠',
    '| 対象 | 状態 | 根拠 |',
    '|---|---|---|',
    `| ${requirement} | ${requirementStatus} | 検証済み |`,
    '',
    '## 指摘ごとの裁定',
    '| finding ID / 出典 | 技術的妥当性 | 裁定 | 根拠 |',
    '|---|---|---|---|',
    `| FINDING-1 | 確認済み | ${findingStatus} | 修正対象 |`,
    '',
    '## 前段 finding の再評価',
    '- peer-review-1',
  ].join('\n');
}

function reviewDecisionWithActionableFamilies(): string {
  return [
    '# Review decision',
    '',
    '## Requirement Decision Grounds',
    '| Subject | Status | Grounds |',
    '|---|---|---|',
    '| failed instruct | satisfied | verified |',
    '',
    '## Actionable Families',
    '| Family | Status | Source findings |',
    '|---|---|---|',
    '| FAM-1 | actionable | FINDING-1, FINDING-2 |',
    '',
    '## Finding Dispositions',
    '| Finding ID / Source | Disposition | Basis |',
    '|---|---|---|',
    '| FINDING-1 | actionable | direct criterion |',
    '| FINDING-2 | actionable | direct criterion |',
    '| FINDING-3 | actionable | direct criterion |',
    '| FINDING-4 | actionable | direct criterion |',
    '| FINDING-5 | actionable | direct criterion |',
    '| FINDING-6 | actionable | direct criterion |',
    '',
    '## Re-evaluation of Prior Findings',
    '- FINDING-1 remains actionable.',
  ].join('\n');
}

describe('run report summary', () => {
  it('実際の日本語最終検証表から充足要件と未実証ゲートを抽出する', () => {
    const summary = summarizeRunReports([{
      filename: 'subworkflows/iteration-7--step-final-gate/supervisor-validation.md',
      content: supervisorValidation(
        'failed instruct',
        '充足',
        'npm run test:e2e:mock',
        ['| 2 | E2E | order.md | 判定不能 | 未実行 |'],
      ),
    }]);

    expect(summary).not.toBeNull();
    expect(summary?.fulfilledRequirements).toEqual(['failed instruct']);
    expect(summary?.unresolvedFindingCount).toBe(1);
    expect(summary?.unverifiedGates).toEqual(['- npm run test:e2e:mock']);
  });

  it('英語の最終検証表も同じ契約で解析する', () => {
    const summary = summarizeRunReports([{
      filename: 'supervisor-validation.md',
      content: [
        '## Requirements Fulfillment Check',
        '| # | Requirement | Source | Status | Evidence |',
        '|---|---|---|---|---|',
        '| 1 | failed instruct | order.md | Fulfilled | executed |',
        '## Re-evaluation of Prior Findings',
        '| Finding | Resolution Status | Evidence |',
        '|---|---|---|',
        '| F-1 | Unresolved | pending |',
        '## Reason the Decision Cannot Be Made (when BLOCKED)',
        '- npm run test:e2e:mock',
      ].join('\n'),
    }]);

    expect(summary?.fulfilledRequirements).toEqual(['failed instruct']);
    expect(summary?.unresolvedFindingCount).toBe(1);
    expect(summary?.unverifiedGates).toEqual(['- npm run test:e2e:mock']);
  });

  it('実際の review-decision contract の Subject、Status、裁定履歴を解析する', () => {
    const summary = summarizeRunReports([{
      filename: 'subworkflows/iteration-10--step-peer-review/review-resolution.md',
      content: reviewDecision('failed instruct', 'satisfied', 'unresolved', 'peer-review-1'),
    }]);

    expect(summary).not.toBeNull();
    expect(summary?.fulfilledRequirements).toEqual(['failed instruct']);
    expect(summary?.unresolvedFindingCount).toBe(1);
    expect(summary?.reviewHistory).toEqual(['- peer-review-1']);
  });

  it('review-decisionのfamily節と履歴節をfinding数へ重複計上しない', () => {
    const summary = summarizeRunReports([{
      filename: 'review-resolution.md',
      content: reviewDecisionWithActionableFamilies(),
    }]);

    expect(summary?.unresolvedFindingCount).toBe(6);
  });

  it('実際の日本語 review-decision contract の対象、状態、裁定を解析する', () => {
    const summary = summarizeRunReports([{
      filename: 'review-resolution.md',
      content: reviewDecisionJa('failed instruct', '充足', 'actionable'),
    }]);

    expect(summary?.fulfilledRequirements).toEqual(['failed instruct']);
    expect(summary?.unresolvedFindingCount).toBe(1);
    expect(summary?.reviewHistory).toEqual(['- peer-review-1']);
  });

  it('日本語の未解決の前提と空のfinding表を解析する', () => {
    const summary = summarizeRunReports([{
      filename: 'review-resolution.md',
      content: [
        '# レビュー指摘裁定',
        '',
        '## 要件の判定根拠',
        '| 対象 | 状態 | 根拠 |',
        '|---|---|---|',
        '| failed instruct | 充足 | 検証済み |',
        '',
        '## 指摘ごとの裁定',
        '| finding ID / 出典 | 技術的妥当性 | 裁定 | 根拠 |',
        '|---|---|---|---|',
        '',
        '## 未解決の前提',
        '- npm run test:e2e:mock',
      ].join('\n'),
    }]);

    expect(summary?.unresolvedFindingCount).toBe(0);
    expect(summary?.unverifiedGates).toEqual(['- npm run test:e2e:mock']);
    expect(formatRunReportSummary(summary!)).toContain('未解決 finding: 0件');
  });

  it('日本語の未解決の前提にあるなしの記述をゲートとして出力しない', () => {
    const summary = summarizeRunReports([{
      filename: 'review-resolution.md',
      content: [
        '## 要件の判定根拠',
        '| 対象 | 状態 | 根拠 |',
        '|---|---|---|',
        '| failed instruct | 充足 | 検証済み |',
        '## 未解決の前提',
        '- なし。指摘・要求・計画の競合はありません。',
      ].join('\n'),
    }]);

    expect(summary?.unverifiedGates).toEqual([]);
    expect(formatRunReportSummary(summary!)).not.toContain('指摘・要求・計画の競合');
  });

  it('primary reportを契約種別、数値iteration、親子深度、パス順で決定する', () => {
    const summary = summarizeRunReports([
      {
        filename: 'subworkflows/iteration-2--step-final-gate/supervisor-validation.md',
        content: supervisorValidation('古い要件', '充足'),
      },
      {
        filename: 'subworkflows/iteration-10--step-final-gate/subworkflows/iteration-2--step-child/supervisor-validation.md',
        content: supervisorValidation('子の要件', '充足'),
      },
      {
        filename: 'subworkflows/iteration-10--step-final-gate/supervisor-validation.md',
        content: supervisorValidation('最新の要件', '充足'),
      },
    ]);

    expect(summary?.fulfilledRequirements).toEqual(['最新の要件']);
  });

  it('同じfinal-gate occurrenceではsupervisor-validationをsummaryより優先する', () => {
    const scope = 'subworkflows/iteration-10--step-final-gate--workflow-final-gate';
    const summary = summarizeRunReports([
      {
        filename: `${scope}/summary.md`,
        content: [
          '## 要件充足',
          '- 古い要約: 充足',
          '## 前段 finding',
          '- FINDING-1: 未解消',
        ].join('\n'),
      },
      {
        filename: `${scope}/supervisor-validation.md`,
        content: supervisorValidation('最終ゲートの要件', '充足', 'npm run test:e2e:mock'),
      },
    ]);

    expect(summary?.fulfilledRequirements).toEqual(['最終ゲートの要件']);
    expect(summary?.unverifiedGates).toEqual(['- npm run test:e2e:mock']);
  });

  it('同じiterationではfinal-gate occurrenceをreview-adjudicationより優先する', () => {
    const summary = summarizeRunReports([
      {
        filename: 'subworkflows/iteration-10--step-review-adjudication--workflow-peer-review-adjudication/review-resolution.md',
        content: reviewDecision('裁定時点の要件', 'satisfied', 'actionable', 'peer-review-1'),
      },
      {
        filename: 'subworkflows/iteration-10--step-final-gate--workflow-peer-review-final-gate/review-resolution.md',
        content: supervisorValidation('最終ゲートの要件', '充足', 'npm run test:e2e:mock'),
      },
    ]);

    expect(summary?.fulfilledRequirements).toEqual(['最終ゲートの要件']);
    expect(summary?.unverifiedGates).toEqual(['- npm run test:e2e:mock']);
  });

  it('コード fenceの種類と長さを追跡し、fence内の同名見出しを裁定sectionとして扱わない', () => {
    const summary = summarizeRunReports([{
      filename: 'supervisor-validation.md',
      content: [
        '## 要件充足チェック',
        '| # | 分解した要件 | 元要件の出典 | 充足 | 根拠 |',
        '|---|---|---|---|---|',
        '| 1 | 要件A | order.md | 充足 | 実行 |',
        '````markdown',
        '## 判定不能の理由（BLOCKED の場合）',
        '- npm run destructive-command',
        '~~~',
        '## 別の偽見出し',
        '- npm run another-destructive-command',
        '```',
        '````',
        '## 判定不能の理由（BLOCKED の場合）',
      ].join('\n'),
    }]);

    expect(summary?.fulfilledRequirements).toEqual(['要件A']);
    expect(summary?.unverifiedGates).toEqual([]);
    expect(formatRunReportSummary(summary!)).not.toContain('destructive-command');
  });

  it('tilde fenceで全体を囲んだreportも解析する', () => {
    const summary = summarizeRunReports([{
      filename: 'supervisor-validation.md',
      content: [
        '~~~markdown',
        supervisorValidation('wrapped requirement', '充足'),
        '~~~',
      ].join('\n'),
    }]);

    expect(summary?.fulfilledRequirements).toEqual(['wrapped requirement']);
  });

  it('未知形式は要約を生成せず、既知の旧ファイル名も互換aliasとして扱わない', () => {
    expect(summarizeRunReports([{
      filename: 'review-resolution.md',
      content: '# unrelated report\n\n## Notes\n- arbitrary text',
    }])).toBeNull();
    expect(summarizeRunReports([{
      filename: 'supervisor-summary.md',
      content: '## Notes\n- arbitrary text',
    }])).toBeNull();
    expect(summarizeRunReports([{
      filename: 'supervisor-validation.md',
      content: '## Requirement Fulfillment Check\n- arbitrary text',
    }])).toBeNull();
    expect(summarizeRunReports([{
      filename: 'review-resolution.md',
      content: '## Requirement Decision Grounds\n- arbitrary text',
    }])).toBeNull();
    expect(summarizeRunReports([
      {
        filename: 'subworkflows/iteration-1--step-final-gate/supervisor-validation.md',
        content: supervisorValidation('old requirement', '充足'),
      },
      {
        filename: 'subworkflows/iteration-2--step-final-gate/supervisor-validation.md',
        content: '## Requirements Fulfillment Check\n- not a contract',
      },
    ])).toBeNull();
  });

  it('必須要件表のない既知primaryはゲート節だけでは要約しない', () => {
    expect(summarizeRunReports([{
      filename: 'supervisor-validation.md',
      content: [
        '# 最終検証結果',
        '',
        '## 要件充足チェック',
        '- 要件表は生成されなかった',
        '',
        '## 判定不能の理由（BLOCKED の場合）',
        '- npm run test:e2e:mock',
      ].join('\n'),
    }])).toBeNull();
  });

  it('summary.mdの実形式を解析する', () => {
    const summary = summarizeRunReports([{
      filename: 'summary.md',
      content: [
        '## 要件充足',
        '- failed instruct: 充足',
        '## 前段 finding',
        '- FINDING-1: 未解消',
      ].join('\n'),
    }]);

    expect(summary?.fulfilledRequirements).toEqual(['failed instruct: 充足']);
    expect(summary?.unresolvedFindingCount).toBe(1);
  });

  it('レポートがない場合は推測で要約を生成しない', () => {
    expect(summarizeRunReports([])).toBeNull();
  });
});
