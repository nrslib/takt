import { describe, expect, it } from 'vitest';
import { buildManagerInstruction, collectDuplicateLocusGroups } from '../core/workflow/findings/manager-agent.js';
import type { FindingLedger, FindingLedgerEntry } from '../core/workflow/findings/types.js';

function openFinding(id: string, title: string, location?: string): FindingLedgerEntry {
  return {
    id,
    status: 'open',
    lifecycle: 'new',
    severity: 'medium',
    title,
    ...(location !== undefined ? { location } : {}),
    reviewers: ['coding-review'],
    rawFindingIds: [`raw-${id}`],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
  };
}

function ledgerWith(findings: FindingLedgerEntry[]): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: findings.length + 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    rawFindings: [],
    conflicts: [],
    findings,
  };
}

function buildInstruction(ledger: FindingLedger): string {
  return buildManagerInstruction({
    contract: {
      ledgerPath: '.takt/findings/ledger.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: { persona: 'findings-manager', instruction: 'Reconcile.', outputContract: 'Return JSON.' },
    } as never,
    previousLedger: ledger,
    ledgerCopyPath: '/tmp/ledger-copy.json',
    rawFindingsPath: '/tmp/raw.json',
    residualRawFindings: [],
    mechanicallyClassifiedCount: 0,
    invalidLocationCandidates: new Map(),
    dismissCandidates: new Map(),
  });
}

describe('buildManagerInstruction duplicate locus groups', () => {
  it('同一ファイルを引用する open finding が2件以上あるときグループとして抽出する（行範囲形式も同一ファイル扱い）', () => {
    const groups = collectDuplicateLocusGroups(ledgerWith([
      openFinding('F-0001', 'RFC 3339 の小数秒をミリ秒へ丸めて履歴順を逆転させる', 'src/core/models/rfc3339.ts:40'),
      openFinding('F-0002', 'RFC 3339 のミリ秒未満を失い裁定履歴の実時間順が逆転する', 'src/core/models/rfc3339.ts:55-60'),
      openFinding('F-0003', '別ファイルの単独指摘', 'src/core/workflow/findings/store.ts:10'),
    ]));

    expect([...groups.keys()]).toEqual(['src/core/models/rfc3339.ts']);
    expect(groups.get('src/core/models/rfc3339.ts')?.map((finding) => finding.id)).toEqual(['F-0001', 'F-0002']);
  });

  it('レンダリングはグループの全メンバーを instruction のグループセクションへ反映する（スモーク）', () => {
    const instruction = buildInstruction(ledgerWith([
      openFinding('F-0001', 'RFC 3339 の小数秒をミリ秒へ丸めて履歴順を逆転させる', 'src/core/models/rfc3339.ts:40'),
      openFinding('F-0002', 'RFC 3339 のミリ秒未満を失い裁定履歴の実時間順が逆転する', 'src/core/models/rfc3339.ts:55-60'),
    ]));

    // グループブロックは見出し文と「Return only structured output」の間に出力される
    // （後続の台帳 JSON に同じ id/path が現れるため境界で区切る）。
    const afterHeading = instruction.split('cite the same file')[1] ?? '';
    const section = afterHeading.split('Return only structured output')[0] ?? '';
    expect(section).toContain('- src/core/models/rfc3339.ts:');
    expect(section).toContain('  - F-0001 [medium]');
    expect(section).toContain('  - F-0002 [medium]');
  });

  it('グループが無いときは統合候補セクション自体を出さない', () => {
    expect(collectDuplicateLocusGroups(ledgerWith([
      openFinding('F-0001', 'a', 'src/a.ts:1'),
      openFinding('F-0002', 'b', 'src/b.ts:1'),
    ])).size).toBe(0);
    const instruction = buildInstruction(ledgerWith([
      openFinding('F-0001', 'a', 'src/a.ts:1'),
      openFinding('F-0002', 'b', 'src/b.ts:1'),
    ]));

    expect(instruction).not.toContain('cite the same file');
  });

  it('provisional と closed の finding はグループ対象にしない', () => {
    const provisional = {
      ...openFinding('F-0001', '暫定', 'src/a.ts:1'),
      provisional: {
        kind: 'unverified-locationless' as const,
        stableKey: 's1',
        lineageKey: 'l1',
        sourceRawFindingIds: ['raw-F-0001'],
        reason: 'r',
        firstObservedAt: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
        lastObservedAt: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
        interpretationEpochs: 0,
        gateEffect: 'block' as const,
      },
    };
    const resolved = { ...openFinding('F-0002', '解消済み', 'src/a.ts:2'), status: 'resolved' as const };
    const open = openFinding('F-0003', 'open 単独', 'src/a.ts:3');

    expect(collectDuplicateLocusGroups(ledgerWith([provisional, resolved, open])).size).toBe(0);
  });
});
