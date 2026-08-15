import { describe, expect, it } from 'vitest';
import assertReviewAdjudication from '../../eval/asserts/review-adjudication.mjs';

const findings = {
  code: 'CODE-NEW-channel-normalization-L2',
  architecture: 'ARCH-NEW-channel-normalization-L2',
  horizontal: 'ARCH-NEW-build-label-dup-L1',
  testing: 'TEST-NEW-readme-examples-L1',
  security: 'SEC-NEW-secret-leak-L3',
  antipattern: 'AI-NEW-windows-proof-L1',
};

function adjudicationOutput(): string {
  return [
    'Result: ACTIONABLE FINDINGS',
    '',
    '## Actionable Families',
    '',
    '### FAM-channel-normalization',
    `- Finding IDs: ${findings.code}, ${findings.architecture}`,
    '- Violated quality principle: the DRY and responsibility boundary is broken.',
    '- Affected contract/call paths: the public execution path duplicates channel validation.',
    '- Minimal internal repair: call normalizeChannel once at the shared boundary and remove the duplication.',
    '- Existing contract: preserve the existing observable contract and behavior.',
    '- Acceptance criteria:',
    '  - Accept local and cloud values case-insensitively with surrounding whitespace ignored.',
    '  - Invalid values fail fast.',
    '  - Do not add legacy aliases.',
    '',
    '## Finding Dispositions',
    '',
    '| Finding ID / source | Technical validity | Disposition | Target family | Reason to change from the same cause | Authorization basis | Reason absent from initial round | Evidence |',
    '|---------------------|--------------------|-------------|---------------|--------------------------------------|---------------------|----------------------------------|----------|',
    `| ${findings.code} | Confirmed | actionable | FAM-channel-normalization | Every execution path must use the shared channel normalization boundary. | direct_acceptance_criterion_violation | not applicable | The confirmed DRY defect remains actionable; the reviewer-suggested transaction is out of scope. |`,
    `| ${findings.architecture} | Confirmed | duplicate | FAM-channel-normalization | Every execution path must use the shared channel normalization boundary. | direct_acceptance_criterion_violation | not applicable | Same responsibility-boundary defect; atomicity has no requirement and is not adopted. |`,
    `| ${findings.horizontal} | Confirmed | out_of_scope | none | Build labels change independently from channel normalization. | none | not applicable | The duplication is technically valid but belongs to an unchanged neighboring contract. |`,
    `| ${findings.testing} | Confirmed | out_of_scope | none | README examples change independently from the execution contract. | none | not applicable | README variation coverage is unrelated to the changed execution path. |`,
    `| ${findings.security} | Disproved | false_positive | none | not applicable | none | not applicable | Current code contains no secret leak. |`,
    `| ${findings.antipattern} | Unverified | environment_unverified | none | not applicable | none | not applicable | The environment-only proof cannot establish an implementation defect. |`,
  ].join('\n');
}

function compactJapaneseAdjudicationOutput(): string {
  return [
    '## 裁定結果',
    '',
    '修正対象は1 familyです。',
    '',
    '| finding ID / 出典 | 技術的妥当性 | 裁定 | 対象 family | 同じ原因で変更される理由 | authorization basis | 初回に含まれなかった理由 | 根拠 |',
    '|---|---|---|---|---|---|---|---|',
    `| ${findings.code} | 確認済み | actionable | F-CHANNEL-NORMALIZATION | 全実行経路を共通の正規化境界へ揃える | direct_acceptance_criterion_violation | 該当なし | 代表 finding |`,
    `| ${findings.architecture} | 確認済み | duplicate | F-CHANNEL-NORMALIZATION | 全実行経路を共通の正規化境界へ揃える | direct_acceptance_criterion_violation | 該当なし | 同じ根本原因へ統合し、transaction方式は不採用 |`,
    `| ${findings.horizontal} | 確認済み | out_of_scope | なし | build label は channel 正規化とは別の理由で変更される | なし | 該当なし | 別契約の技術的に妥当な重複だが修正権限なし |`,
    `| ${findings.testing} | 確認済み | out_of_scope | なし | 文書例は実行契約とは別の理由で変更される | なし | 該当なし | 文書の全パターン列挙は変更の正しさと無関係 |`,
    `| ${findings.security} | 反証済み | false_positive | なし | 該当なし | なし | 該当なし | 現コードは秘密値を出力しない |`,
    `| ${findings.antipattern} | 未確認 | out_of_scope | なし | 該当なし | なし | 該当なし | Windows証跡は要求されていない |`,
    '',
    '### Actionable family: `channel-normalization`',
    '',
    `- 主 finding: ${findings.code}`,
    `- 統合 finding: ${findings.architecture}`,
    '- 根本原因: 正規化の責務境界を複製している。',
    '',
    '**受入条件**',
    '',
    '- 入口で normalizeChannel を使用し、独自判定を残さない。',
    '- " LOCAL " は "local"、"Cloud" は "cloud" として受理する。',
    '- 不正値は即座に例外とする。',
    '- alias、fallback、互換変換を追加しない。',
    '- transaction／rollbackなど、新しい外部保証を追加しない。',
  ].join('\n');
}

function currentFamilyMergeOutput(): string {
  return [
    '裁定結果は「修正対象あり」です。次工程へ渡す正本は1 familyです。',
    '',
    '## 修正対象 family',
    '',
    '- Family ID: `FAM-channel-normalization`',
    '- 不変条件: accepted `local` / `cloud` strings are normalized once and retained by every execution path.',
    '- 担当箇所: `normalizeChannel` in `src/channel.js`',
    '- 権限根拠: `direct_acceptance_criterion_violation`',
    '- 現在の違反: execution.js が独自に raw 値を検証・保持するため、" LOCAL " など要求上有効な入力を拒否する。',
    '- 受入条件:',
    '  - 大小文字と周辺空白を無視して `local` / `cloud` を受理する。',
    '  - execution object には必ず正規化済みの小文字値を保持する。',
    '  - その他の値は execution 作成前に失敗する。',
    '  - legacy alias は追加しない。',
    '- 修正境界: buildExecution を既存の normalizeChannel へ配線し、返された値を保持する。transaction、rollback は含めない。',
    '',
    '## 指摘ごとの裁定',
    '',
    '| finding ID / 出典 | 技術的妥当性 | 裁定 | 対象 family | 同じ原因で変更される理由 | authorization basis | 初回に含まれなかった理由 | 根拠 |',
    '|---|---|---|---|---|---|---|---|',
    `| ${findings.code} | 確認済み | actionable | FAM-channel-normalization | 全実行経路を共通の正規化境界へ揃える | direct_acceptance_criterion_violation | 該当なし | 上記 family。" LOCAL " が現在の execution 経路で拒否される直接違反。 |`,
    `| ${findings.architecture} | 確認済み | duplicate | FAM-channel-normalization | 全実行経路を共通の正規化境界へ揃える | direct_acceptance_criterion_violation | 該当なし | 同じ担当箇所・不変条件・根本原因。FAM-channel-normalization へ統合。transaction 提案は過剰方式として不採用。 |`,
    `| ${findings.horizontal} | 確認済み | out_of_scope | なし | build label は channel 正規化とは別の理由で変更される | なし | 該当なし | 重複実装は確認できるが、channel 契約とは owner・不変条件・変更理由が異なり、修正権限がない。 |`,
    `| ${findings.testing} | 確認済み | out_of_scope | なし | 文書例は実行契約とは別の理由で変更される | なし | 該当なし | 全表記の文書列挙は受入条件でも必須 consumer migration でもない。 |`,
    `| ${findings.security} | 反証済み | false_positive | なし | 該当なし | なし | 該当なし | エラーは固定文字列で、raw 値を含まない。 |`,
    `| ${findings.antipattern} | 反証済み | overreach | なし | 該当なし | なし | 該当なし | Windows 実行を要求する契約も実装欠陥の証拠もない。 |`,
  ].join('\n');
}

function withSourceFindingsTable(output: string, sourceFindings: string): string {
  return output.replace(
    '### FAM-channel-normalization',
    [
      '| family | Source findings | Evidence |',
      '|---|---|---|',
      `| FAM-channel-normalization | ${sourceFindings} | Confirmed at the changed boundary. |`,
      '',
      '### FAM-channel-normalization',
    ].join('\n'),
  );
}

function withoutDispositionField(output: string, findingId: string, columnIndex: number): string {
  return output.split('\n').map((line) => {
    if (!line.includes(`| ${findingId} |`)) return line;
    const cells = line.split('|');
    cells[columnIndex + 1] = ' ';
    return cells.join('|');
  }).join('\n');
}

describe('review adjudication assertion', () => {
  it('accepts a directly related quality defect while separating non-actionable findings', () => {
    const result = assertReviewAdjudication(adjudicationOutput());

    expect(result.pass, result.reason).toBe(true);
  });

  it('allows a non-actionable finding to be mentioned without assigning it to the family', () => {
    const baseOutput = adjudicationOutput();
    const contractLine = '- Existing contract: preserve the existing observable contract and behavior.';
    expect(baseOutput).toContain(contractLine);
    const output = baseOutput.replace(
      contractLine,
      `${contractLine} ${findings.testing} remains excluded.`,
    );
    expect(output).toContain(`${findings.testing} remains excluded.`);
    const result = assertReviewAdjudication(output);

    expect(result.pass, result.reason).toBe(true);
  });

  it('ignores excluded English finding ownership and shared ID prefixes', () => {
    const output = adjudicationOutput().replace(
      '- Existing contract: preserve the existing observable contract and behavior.',
      [
        '- Existing contract: preserve the existing observable contract and behavior.',
        `- Source findings: ${findings.testing} (excluded from this family)`,
        `- Source findings: ${findings.testing}-10`,
      ].join('\n'),
    );
    const result = assertReviewAdjudication(output);

    expect(result.pass, result.reason).toBe(true);
  });

  it('parses source-first finding columns and rejects non-actionable membership', () => {
    const validOutput = withSourceFindingsTable(
      adjudicationOutput(),
      `${findings.code}, ${findings.architecture}`,
    );
    const invalidOutput = withSourceFindingsTable(
      adjudicationOutput(),
      `${findings.code}, ${findings.architecture}, ${findings.testing}`,
    );

    expect(assertReviewAdjudication(validOutput).pass).toBe(true);
    const invalidResult = assertReviewAdjudication(invalidOutput);
    expect(invalidResult.pass).toBe(false);
    expect(invalidResult.reason).toContain('non-actionable-excluded-from-family');
  });

  it('ignores a Japanese finding ownership line marked out of scope', () => {
    const output = compactJapaneseAdjudicationOutput().replace(
      '- 根本原因: 正規化の責務境界を複製している。',
      `- 根本原因: 正規化の責務境界を複製している。\n- 指摘 ID: ${findings.testing}（対象外）`,
    );
    const result = assertReviewAdjudication(output);

    expect(result.pass, result.reason).toBe(true);
  });

  it('rejects an output that promotes the reviewer-suggested transaction mechanism', () => {
    const output = adjudicationOutput().replace(
      'the reviewer-suggested transaction is out of scope',
      'add a transaction boundary',
    );
    const result = assertReviewAdjudication(output);

    expect(result.pass).toBe(false);
    expect(result.reason).toContain('suggested-mechanism-not-promoted');
  });

  it('accepts a compact Japanese disposition table with combined family and reason', () => {
    const result = assertReviewAdjudication(compactJapaneseAdjudicationOutput());

    expect(result.pass, result.reason).toBe(true);
  });

  it('accepts a generic adjudication detail column containing family and evidence', () => {
    const output = compactJapaneseAdjudicationOutput()
      .replace('| 根拠 |', '| 裁定詳細 |')
      .replace(
        '- " LOCAL " は "local"、"Cloud" は "cloud" として受理する。',
        '- `local`、`LOCAL`、" local " は `local` として受理する。\n- `cloud`、`CLOUD`、" cloud " は `cloud` として受理する。',
      )
      .replace('不正値は即座に例外とする。', 'local / cloud 以外は実行オブジェクト生成前に失敗する。');
    expect(output).toContain('| 初回に含まれなかった理由 | 裁定詳細 |');

    const result = assertReviewAdjudication(output);

    expect(result.pass, result.reason).toBe(true);
  });

  it.each([
    ['Technical validity', findings.code, 1, 'technical-validity-present'],
    ['Reason to change from the same cause', findings.architecture, 4, 'reason-to-change-present'],
    ['Authorization basis', findings.horizontal, 5, 'authorization-basis-present'],
    ['Reason absent from initial round', findings.antipattern, 6, 'reason-absent-present'],
  ] as const)('rejects a disposition row missing %s', (_field, findingId, columnIndex, failedCheck) => {
    const output = withoutDispositionField(adjudicationOutput(), findingId, columnIndex);
    const result = assertReviewAdjudication(output);

    expect(result.pass).toBe(false);
    expect(result.reason).toContain(failedCheck);
  });

  it('accepts a compact family merger expressed through the actionable family and disposition rationale', () => {
    const result = assertReviewAdjudication(currentFamilyMergeOutput());

    expect(result.pass, result.reason).toBe(true);
  });

  it('rejects a compact merger when the duplicate targets a different family', () => {
    const output = currentFamilyMergeOutput().replace(
      `| ${findings.architecture} | 確認済み | duplicate | FAM-channel-normalization |`,
      `| ${findings.architecture} | 確認済み | duplicate | FAM-other-channel-contract |`,
    );
    const result = assertReviewAdjudication(output);

    expect(result.pass).toBe(false);
    expect(result.reason).toContain('same-actionable-family');
  });
});
