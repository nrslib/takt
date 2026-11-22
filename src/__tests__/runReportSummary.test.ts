import { describe, expect, it } from 'vitest';
import {
  formatRunReportSummary,
  summarizeRunReports,
} from '../features/tasks/list/runReportSummary.js';

function supervisorValidation(
  requirement: string,
  status = 'Fulfilled',
  findingStatus = 'Unresolved',
  gate?: string,
): string {
  return [
    '## Requirements Fulfillment Check',
    '| # | Requirement | Source | Status | Evidence |',
    '|---|---|---|---|---|',
    `| 1 | ${requirement} | order.md | ${status} | executed |`,
    '## Re-evaluation of Prior Findings',
    '| Finding | Resolution Status | Evidence |',
    '|---|---|---|',
    `| finding-for-${requirement} | ${findingStatus} | observed |`,
    '## Reason the Decision Cannot Be Made (when BLOCKED)',
    ...(gate ? [`- ${gate}`] : []),
  ].join('\n');
}

describe('run report summary', () => {
  it('extracts requirement, finding, and gate data from a report table', () => {
    const requirement = 'dynamic requirement';
    const gate = 'npm run verify-dynamic';
    const summary = summarizeRunReports([{
      filename: 'supervisor-validation.md',
      content: supervisorValidation(requirement, 'Fulfilled', 'Unresolved', gate),
    }]);

    expect(summary).toEqual({
      fulfilledRequirements: [requirement],
      unresolvedFindingCount: 1,
      reviewHistory: [`| finding-for-${requirement} | Unresolved | observed |`],
      unverifiedGates: [`- ${gate}`],
    });
  });

  it('extracts review-decision requirement status and history', () => {
    const requirement = 'reviewed requirement';
    const history = 'review-run-7';
    const summary = summarizeRunReports([{
      filename: 'subworkflows/iteration-7--step-peer-review/review-resolution.md',
      content: [
        '## Requirement Decision Grounds',
        '| Subject | Status | Grounds |',
        '|---|---|---|',
        `| ${requirement} | satisfied | verified |`,
        '## Finding Dispositions',
        '| Finding ID / Source | Disposition | Basis |',
        '|---|---|---|',
        '| finding-1 | actionable | direct criterion |',
        '## Re-evaluation of Prior Findings',
        `- ${history}`,
      ].join('\n'),
    }]);

    expect(summary?.fulfilledRequirements).toEqual([requirement]);
    expect(summary?.unresolvedFindingCount).toBe(1);
    expect(summary?.reviewHistory).toEqual([`- ${history}`]);
  });

  it('extracts the natural-language review decision contract', () => {
    const summary = summarizeRunReports([{
      filename: 'review-resolution.md',
      content: [
        '## 要件との照合',
        '| 対象 | 状態 | 根拠 |',
        '|---|---|---|',
        '| 設定値を正規化する | 充足 | src/config.ts:10 |',
        '## 指摘ごとの判断',
        '| finding ID / 出典 | 技術的な確認結果 | 今回の扱い | 対応する問題ID | 理由と根拠 |',
        '|---|---|---|---|---|',
        '| CONFIG-1 | 確認済み | 修正する | config-normalization | src/config.ts:10 |',
      ].join('\n'),
    }]);

    expect(summary?.fulfilledRequirements).toEqual(['設定値を正規化する']);
    expect(summary?.unresolvedFindingCount).toBe(1);
  });

  it.each([
    {
      language: 'ja',
      result: '結果: 修正対象あり',
      decision: '判定の要約',
      inherited: '引き継いだ問題の状態',
      inheritedHeader: '| 問題ID | 元の受入条件 | 現在の状態 | 採用した確認結果と対象コード状態 | 解消状態の判定に残る確認・矛盾 |',
      inheritedRow: '| CONFIG-OLD | 設定の互換性 | 解消済み | verify.md のコード状態で確認 | なし |',
      repairs: '修正する問題',
      repairsHeader: '| 問題ID | 関係する指摘 | 破られる条件 | 原因 | 関係する経路 | 根拠 | 受入条件 | 修正範囲 |',
      references: '固定版の参照先',
      referencesHeader: '| 問題ID | 実行識別と順序 | 計画・修正・検証の参照先 | 欠落・未完了 |',
      findings: '指摘ごとの判断',
      findingsHeader: '| finding ID / 出典 | 技術的な確認結果 | 今回の扱い | 対応する問題ID | 理由と根拠 |',
      treatments: ['修正する', '同じ問題へ統合', '外部確認待ち', '環境上確認不能', '持ち越す', '今回の修正対象にする', '根拠なし'],
      external: '外部確認待ち',
      externalHeader: '| 問題ID | 未確認の受入条件 | 要求上の根拠 | この環境で完了した修正と検証（対象のコード状態を含む） | 確認先と方法 | 確定に必要な証拠 |',
      environment: '環境上確認不能',
      environmentHeader: '| 指摘ID / 出典 | 未確認の条件 | この環境で確認できない理由 | 確定に必要な証拠 |',
      premises: '未解決の前提',
      premisesHeader: '| 指摘ID / 出典 | 確認済みの事実 | 採否・受入条件を決めるための未確定事項 | 次に必要な確認・判断 | 渡し先 |',
    },
    {
      language: 'en',
      result: 'Result: Problems require repair',
      decision: 'Decision Summary',
      inherited: 'Inherited Problem Status',
      inheritedHeader: '| Problem ID | Original Acceptance Criteria | Current Status | Adopted Results and Target Code State | Checks or Conflicts Remaining to Determine Resolution Status |',
      inheritedRow: '| CONFIG-OLD | Configuration compatibility | Resolved | verify.md for target code state | None |',
      repairs: 'Problems to Repair',
      repairsHeader: '| Problem ID | Related Findings | Violated Condition | Cause | Relevant Paths | Evidence | Acceptance Criteria | Repair Boundary |',
      references: 'Fixed-Version References',
      referencesHeader: '| Problem ID | Execution Identity and Order | Plan, Repair, and Verification References | Missing or Incomplete Records |',
      findings: 'Decision for Each Finding',
      findingsHeader: '| Finding ID / Source | Technical Check | Treatment in This Task | Problem ID | Reason and Evidence |',
      treatments: ['Repair', 'Merge into same problem', 'Awaiting external confirmation', 'Cannot verify in this environment', 'Carry forward', 'Repair in this round', 'Unsupported'],
      external: 'Awaiting External Confirmation',
      externalHeader: '| Problem ID | Unverified Acceptance Criterion | Requirement Basis | Repairs and Verification Completed in This Environment (Including Target Code State) | Where and How to Confirm | Evidence Needed to Decide |',
      environment: 'Cannot Verify in This Environment',
      environmentHeader: '| Finding ID / Source | Unverified Condition | Why It Cannot Be Verified in This Environment | Evidence Needed to Decide |',
      premises: 'Unresolved Premises',
      premisesHeader: '| Finding ID / Source | Established Facts | Undecided Matter Needed to Determine Acceptance or Acceptance Criteria | Next Check or Decision Needed | Recipient |',
    },
  ])('summarizes the current $language review-decision contract without a requirement table', (contract) => {
    const repairRow = '| CONFIG-NEW | CODE-1, CODE-2 | normalization | missing conversion | config.ts | config.ts:10 | normalized input | parser |';
    const referenceRow = '| CONFIG-OLD | run-1 | iteration-1/verify.md | none |';
    const externalRow = '| CONFIG-EXT | production response | order.md | local check passed | production | response log |';
    const environmentRow = '| ENV-1 / testing-review.md | browser behavior | no browser available | browser trace |';
    const premiseRow = '| PLAN-1 / coding-review.md | current default | required compatibility | confirm requirement | repair planning |';
    const content = [
      `## ${contract.result}`,
      `## ${contract.decision}`,
      'reviewed coding-review.md',
      `## ${contract.inherited}`,
      contract.inheritedHeader,
      '|---|---|---|---|---|',
      contract.inheritedRow,
      `## ${contract.repairs}`,
      contract.repairsHeader,
      '|---|---|---|---|---|---|---|---|',
      repairRow,
      `## ${contract.references}`,
      contract.referencesHeader,
      '|---|---|---|---|',
      referenceRow,
      `## ${contract.findings}`,
      contract.findingsHeader,
      '|---|---|---|---|---|',
      ...contract.treatments.map((treatment, index) => `| CODE-${index} | confirmed | ${treatment} | CONFIG-NEW | evidence |`),
      `## ${contract.external}`,
      contract.externalHeader,
      '|---|---|---|---|---|---|',
      externalRow,
      `## ${contract.environment}`,
      contract.environmentHeader,
      '|---|---|---|---|',
      environmentRow,
      `## ${contract.premises}`,
      contract.premisesHeader,
      '|---|---|---|---|---|',
      premiseRow,
    ].join('\n');

    const summary = summarizeRunReports([{ filename: 'review-resolution.md', content }]);

    expect(summary).toEqual({
      fulfilledRequirements: [],
      unresolvedFindingCount: 5,
      reviewHistory: [contract.result, 'reviewed coding-review.md', contract.inheritedRow, repairRow, referenceRow],
      unverifiedGates: [externalRow, environmentRow, premiseRow],
    });
    const formatted = formatRunReportSummary(summary!);
    for (const value of [contract.result, contract.inheritedRow, repairRow, referenceRow, externalRow, environmentRow, premiseRow]) {
      expect(formatted).toContain(value);
    }
  });

  it.each([
    ['結果: 修正対象なし', '引き継いだ問題の状態', '指摘ごとの判断', '| finding ID / 出典 | 技術的な確認結果 | 今回の扱い | 対応する問題ID | 理由と根拠 |', '確認後は問題なし'],
    ['Result: No problems require repair', 'Inherited Problem Status', 'Decision for Each Finding', '| Finding ID / Source | Technical Check | Treatment in This Task | Problem ID | Reason and Evidence |', 'No issue after verification'],
  ])('reads %s with no inherited problems or repairs', (result, inherited, findings, header, treatment) => {
    const summary = summarizeRunReports([{
      filename: 'review-resolution.md',
      content: [
        `## ${result}`,
        `## ${inherited}`,
        '- none',
        `## ${findings}`,
        header,
        '|---|---|---|---|---|',
        `| CODE-1 | confirmed | ${treatment} | none | config.ts:10 |`,
      ].join('\n'),
    }]);

    expect(summary).toEqual({
      fulfilledRequirements: [],
      unresolvedFindingCount: 0,
      reviewHistory: [result, '- none'],
      unverifiedGates: [],
    });
  });

  it.each([
    ['指摘ごとの判断', '| finding ID / 出典 | 技術的な確認結果 | 今回の扱い | 対応する問題ID | 理由と根拠 |', '持ち越す'],
    ['Decision for Each Finding', '| Finding ID / Source | Technical Check | Treatment in This Task | Problem ID | Reason and Evidence |', 'Carry forward'],
  ])('does not count %s carry-forward notes as unresolved findings', (findings, header, treatment) => {
    const summary = summarizeRunReports([{
      filename: 'review-resolution.md',
      content: [
        `## ${findings}`,
        header,
        '|---|---|---|---|---|',
        `| PLAN-1 / plan.md | 未確認 | ${treatment} | none | 次の工程で扱う留意点 |`,
      ].join('\n'),
    }]);

    expect(summary?.unresolvedFindingCount).toBe(0);
  });

  it.each([
    ['要件充足チェック', '| # | 要件 | 出典 | 状態 | 根拠 |', '充足', '環境上確認不能', '| 指摘ID / 出典 | 未確認の条件 | この環境で確認できない理由 | 確定に必要な証拠 |'],
    ['Requirements Fulfillment Check', '| # | Requirement | Source | Status | Evidence |', 'Fulfilled', 'Cannot Verify in This Environment', '| Finding ID / Source | Unverified Condition | Why It Cannot Be Verified in This Environment | Evidence Needed to Decide |'],
  ])('preserves %s environmental verification limits even when approved', (requirements, header, status, environment, environmentHeader) => {
    const row = '| ENV-1 / testing-review.md | target code state | environment unavailable | external observation |';
    const summary = summarizeRunReports([{
      filename: 'supervisor-validation.md',
      content: [
        '## Result: APPROVE',
        `## ${requirements}`,
        header,
        '|---|---|---|---|---|',
        `| 1 | normalization | order.md | ${status} | config.ts:10 |`,
        `## ${environment}`,
        environmentHeader,
        '|---|---|---|---|',
        row,
      ].join('\n'),
    }]);

    expect(summary?.fulfilledRequirements).toEqual(['normalization']);
    expect(summary?.unresolvedFindingCount).toBe(0);
    expect(summary?.unverifiedGates).toEqual([row]);
    expect(formatRunReportSummary(summary!)).toContain(row);
  });

  it.each([
    ['同じ問題へ統合', '同じ問題へ統合'],
    ['環境上確認不能', '環境上確認不能'],
    ['Merge into same problem', 'Merge into same problem'],
    ['Cannot verify in this environment', 'Cannot verify in this environment'],
  ])('counts %s as unresolved in a natural-language decision', (_label, treatment) => {
    const summary = summarizeRunReports([{
      filename: 'review-resolution.md',
      content: [
        '## 要件との照合',
        '| 対象 | 状態 | 根拠 |',
        '|---|---|---|',
        '| 設定値を正規化する | 充足 | src/config.ts:10 |',
        '## 指摘ごとの判断',
        '| finding ID / 出典 | 技術的な確認結果 | 今回の扱い | 対応する問題ID | 理由と根拠 |',
        '|---|---|---|---|---|',
        `| CONFIG-1 | 未確認 | ${treatment} | config-normalization | 根拠 |`,
      ].join('\n'),
    }]);

    expect(summary?.unresolvedFindingCount).toBe(1);
  });

  it('selects the latest report occurrence instead of an older report', () => {
    const summary = summarizeRunReports([
      {
        filename: 'subworkflows/iteration-2--step-final-gate/supervisor-validation.md',
        content: supervisorValidation('old requirement'),
      },
      {
        filename: 'subworkflows/iteration-10--step-final-gate/supervisor-validation.md',
        content: supervisorValidation('latest requirement'),
      },
    ]);

    expect(summary?.fulfilledRequirements).toEqual(['latest requirement']);
  });

  it('does not interpret headings or gates inside Markdown fences as report sections', () => {
    const summary = summarizeRunReports([{
      filename: 'supervisor-validation.md',
      content: [
        '## Requirements Fulfillment Check',
        '| # | Requirement | Source | Status | Evidence |',
        '|---|---|---|---|---|',
        '| 1 | visible requirement | order.md | Fulfilled | executed |',
        '```markdown',
        '## Reason the Decision Cannot Be Made (when BLOCKED)',
        '- hidden gate',
        '```',
      ].join('\n'),
    }]);

    expect(summary?.fulfilledRequirements).toEqual(['visible requirement']);
    expect(summary?.unverifiedGates).toEqual([]);
  });

  it('does not create a summary from an unknown report shape', () => {
    expect(summarizeRunReports([{
      filename: 'review-resolution.md',
      content: '# unrelated report\n\n## Notes\n- arbitrary text',
    }])).toBeNull();
    expect(summarizeRunReports([])).toBeNull();
  });

  it('formats extracted values for downstream consumers', () => {
    const summary = summarizeRunReports([{
      filename: 'supervisor-validation.md',
      content: supervisorValidation('formatted requirement', 'Fulfilled', 'none', 'gate-for-output'),
    }]);
    expect(summary).not.toBeNull();

    const formatted = formatRunReportSummary(summary!);
    expect(formatted).toContain('formatted requirement');
    expect(formatted).toContain('gate-for-output');
    expect(formatted).toBeTypeOf('string');
    expect(formatted.length).toBeGreaterThan(0);
  });
});
