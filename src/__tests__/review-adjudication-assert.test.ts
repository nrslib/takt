import { describe, expect, it } from 'vitest';
import assertReviewAdjudication from '../../eval/asserts/review-adjudication.mjs';

const findings = {
  code: 'CODE-NEW-channel-normalization-L2',
  architecture: 'ARCH-NEW-channel-normalization-L2',
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
    '| Finding ID | Disposition | Target family | Evidence |',
    '|------------|-------------|---------------|----------|',
    `| ${findings.code} | actionable | FAM-channel-normalization | The confirmed DRY defect remains actionable; the reviewer-suggested transaction is out of scope. |`,
    `| ${findings.architecture} | duplicate | FAM-channel-normalization | Same responsibility-boundary defect; atomicity has no requirement and is not adopted. |`,
    `| ${findings.testing} | out_of_scope | none | README variation coverage is unrelated to the changed execution path. |`,
    `| ${findings.security} | false_positive | none | Current code contains no secret leak. |`,
    `| ${findings.antipattern} | environment_unverified | none | The environment-only proof cannot establish an implementation defect. |`,
  ].join('\n');
}

function compactJapaneseAdjudicationOutput(): string {
  return [
    '## 裁定結果',
    '',
    '修正対象は1 familyです。',
    '',
    '| Finding ID | 裁定 | 統合先／理由 |',
    '|---|---|---|',
    `| ${findings.code} | actionable | F-CHANNEL-NORMALIZATION。代表 finding |`,
    `| ${findings.architecture} | duplicate | F-CHANNEL-NORMALIZATION。同じ根本原因へ統合し、transaction方式は不採用 |`,
    `| ${findings.testing} | out_of_scope | 文書の全パターン列挙は変更の正しさと無関係 |`,
    `| ${findings.security} | false_positive | 現コードは秘密値を出力しない |`,
    `| ${findings.antipattern} | out_of_scope | Windows証跡は要求されていない |`,
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
      .replace('統合先／理由', '裁定')
      .replace(
        '- " LOCAL " は "local"、"Cloud" は "cloud" として受理する。',
        '- `local`、`LOCAL`、" local " は `local` として受理する。\n- `cloud`、`CLOUD`、" cloud " は `cloud` として受理する。',
      )
      .replace('不正値は即座に例外とする。', 'local / cloud 以外は実行オブジェクト生成前に失敗する。');
    expect(output).toContain('| Finding ID | 裁定 | 裁定 |');

    const result = assertReviewAdjudication(output);

    expect(result.pass, result.reason).toBe(true);
  });
});
