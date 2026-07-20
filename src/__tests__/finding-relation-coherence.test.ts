/**
 * レビュア1回突き返し（v2 梯子設計 §3・実装単位4）: relation/target/kind の
 * 意味矛盾がある raw に同一セッションで1回だけ明確化を求める。訂正契約
 * （raw 集合・本文不変）は決定的に検証し、失敗しても raw は drop されない
 * （ambiguous のまま manager 解釈 / provisional へ進む）。taint は engine 発行の
 * clarification メタデータで intake へ引き継がれる。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

import {
  buildRelationCoherenceRegenerationInstruction,
  clarifyAmbiguousRawRelationsOnce,
  detectClarifiableRawMismatches,
} from '../core/workflow/findings/relation-coherence.js';
import type { AgentResponse } from '../core/models/types.js';
import type { FindingLedger, FindingLedgerEntry } from '../core/workflow/findings/types.js';

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

function makeOpenFinding(overrides: Partial<FindingLedgerEntry> = {}): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'high',
    title: 'Secret is logged',
    location: 'src/secret.ts:12',
    description: 'The code logs a token.',
    reviewers: ['coding-review'],
    rawFindingIds: ['raw-existing'],
    firstSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    lastSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    ...overrides,
  };
}

interface WireRaw {
  rawFindingId: string;
  familyTag: string;
  severity: string;
  title: string;
  location: string;
  description: string;
  relation: string;
  targetFindingId: string;
  suggestion: string;
}

function makeRawItem(overrides: Partial<WireRaw> = {}): WireRaw {
  return {
    rawFindingId: 'raw-new',
    familyTag: 'security',
    severity: 'high',
    title: 'Secret is logged',
    location: 'src/secret.ts:40',
    description: 'A different observation of token logging.',
    relation: 'new',
    targetFindingId: '',
    suggestion: '',
    ...overrides,
  };
}

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    version: 1,
    workflowName: 'coherence-test',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    findings: [makeOpenFinding()],
    rawFindings: [],
    conflicts: [],
    ...overrides,
  };
}

describe('detectClarifiableRawMismatches', () => {
  it('relation=new かつ正規化 path+title が open finding と一致する raw を検出する（行番号差は無視）', () => {
    const mismatches = detectClarifiableRawMismatches([makeRawItem()], makeLedger());
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ rawFindingId: 'raw-new', collidingFindingId: 'F-0001' });
    expect(mismatches[0]!.codes).toContain('new-collides-open-finding');
  });

  it('description まで一致する raw は検出しない（decision-assembly が決定的に same へ畳むため）', () => {
    const raw = makeRawItem({ description: 'The code logs a token.' });
    expect(detectClarifiableRawMismatches([raw], makeLedger())).toHaveLength(0);
  });

  it('整合した persists/reopened/resolution_confirmation は対象外', () => {
    const ledger = makeLedger({
      findings: [
        makeOpenFinding(),
        makeOpenFinding({ id: 'F-0002', title: 'Another one', location: 'src/two.ts:1' }),
        makeOpenFinding({ id: 'F-0003', status: 'resolved', lifecycle: 'resolved', title: 'Fixed one', location: 'src/three.ts:1' }),
      ],
    });
    const raws = [
      makeRawItem({ rawFindingId: 'raw-p', relation: 'persists', targetFindingId: 'F-0001' }),
      makeRawItem({ rawFindingId: 'raw-r', relation: 'reopened', targetFindingId: 'F-0003', title: 'Fixed one came back', location: 'src/three.ts:2' }),
      makeRawItem({ rawFindingId: 'raw-c', relation: 'resolution_confirmation', targetFindingId: 'F-0002', title: 'Another one is fixed', location: 'src/two.ts:1' }),
    ];
    expect(detectClarifiableRawMismatches(raws, ledger)).toHaveLength(0);
  });

  it('persists が未知 / 非 open target を指す矛盾を検出する', () => {
    const ledger = makeLedger({
      findings: [makeOpenFinding({ id: 'F-0009', status: 'resolved', lifecycle: 'resolved', title: 'Old', location: 'src/x.ts:1' })],
    });
    const mismatches = detectClarifiableRawMismatches([
      makeRawItem({ rawFindingId: 'raw-unknown', relation: 'persists', targetFindingId: 'F-9999', title: 'T1', location: 'src/a.ts:1' }),
      makeRawItem({ rawFindingId: 'raw-closed', relation: 'persists', targetFindingId: 'F-0009', title: 'T2', location: 'src/b.ts:1' }),
    ], ledger);
    expect(mismatches.map((m) => m.rawFindingId)).toEqual(['raw-unknown', 'raw-closed']);
    expect(mismatches[0]!.codes).toContain('persists-target-unknown');
    expect(mismatches[1]!.codes).toContain('persists-target-not-open');
  });

  it('missing-required-field だけの raw は突き返し対象にしない（本文変更が必要なため ladder 直行）', () => {
    const raw = { rawFindingId: 'raw-broken', relation: 'new' };
    expect(detectClarifiableRawMismatches([raw], makeLedger())).toHaveLength(0);
  });

  it('path または title が一致しない new は検出しない', () => {
    const raws = [
      makeRawItem({ rawFindingId: 'raw-other-path', location: 'src/other.ts:12' }),
      makeRawItem({ rawFindingId: 'raw-other-title', title: 'A completely different issue' }),
    ];
    expect(detectClarifiableRawMismatches(raws, makeLedger())).toHaveLength(0);
  });

  it('open でない finding とは new 衝突しない', () => {
    const ledger = makeLedger({ findings: [makeOpenFinding({ status: 'resolved', lifecycle: 'resolved' })] });
    expect(detectClarifiableRawMismatches([makeRawItem()], ledger)).toHaveLength(0);
  });
});

describe('clarifyAmbiguousRawRelationsOnce', () => {
  const reviewerStructuredOutput = {
    rawFindings: [makeRawItem()],
  };

  function makeResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
    return {
      persona: 'coding-reviewer',
      status: 'done',
      content: 'Review report body.',
      structuredOutput: reviewerStructuredOutput,
      sessionId: 'session-1',
      timestamp: new Date('2026-06-13T00:00:01.000Z'),
      ...overrides,
    };
  }

  const identityNormalize = (response: AgentResponse): { response: AgentResponse; invalidDetail?: string } => ({ response });

  it('1回で直れば再生成出力を採用する（本文は元のまま、structured output だけ差し替え）。taint 用の clarification が付く', async () => {
    executeAgentMock.mockReset();
    const correctedOutput = {
      rawFindings: [makeRawItem({ relation: 'persists', targetFindingId: 'F-0001' })],
    };
    executeAgentMock.mockResolvedValueOnce({
      persona: 'coding-reviewer',
      status: 'done',
      content: JSON.stringify(correctedOutput),
      structuredOutput: correctedOutput,
      sessionId: 'session-2',
      timestamp: new Date('2026-06-13T00:00:02.000Z'),
    });

    const result = await clarifyAmbiguousRawRelationsOnce({
      stepName: 'coding-review',
      persona: 'coding-reviewer',
      response: makeResponse(),
      ledger: makeLedger(),
      agentOptions: { provider: 'claude' },
      normalize: identityNormalize,
    });

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    const [, instruction, options] = executeAgentMock.mock.calls[0]!;
    expect(instruction).toContain('F-0001');
    expect(instruction).toContain('relation "new"');
    expect(options).toMatchObject({ permissionMode: 'readonly', allowedTools: [], sessionId: 'session-1' });
    expect(result.response.content).toBe('Review report body.');
    expect(result.response.structuredOutput).toEqual(correctedOutput);
    expect(result.response.sessionId).toBe('session-2');
    // taint は消えない: correction が成功しても clarification（priorAmbiguityCodes）が残る。
    expect(result.clarification).toBeDefined();
    expect(result.clarification!.flaggedRawFindingIds).toEqual(['raw-new']);
    expect(result.clarification!.priorAmbiguityCodesByRawId['raw-new']).toContain('new-collides-open-finding');
  });

  it('再生成出力が不正なら元の応答を保持する（ステップは失敗させず、drop もしない）', async () => {
    executeAgentMock.mockReset();
    executeAgentMock.mockResolvedValueOnce({
      persona: 'coding-reviewer',
      status: 'done',
      content: 'not json',
      timestamp: new Date('2026-06-13T00:00:02.000Z'),
    });

    const original = makeResponse();
    const result = await clarifyAmbiguousRawRelationsOnce({
      stepName: 'coding-review',
      persona: 'coding-reviewer',
      response: original,
      ledger: makeLedger(),
      agentOptions: { provider: 'claude' },
      normalize: (response) => ({ response, invalidDetail: 'schema validation failed' }),
    });

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(result.response).toBe(original);
    expect(result.clarification).toBeDefined();
  });

  it('意味矛盾が無ければ再生成呼び出しをしない（clarification も付かない）', async () => {
    executeAgentMock.mockReset();
    const response = makeResponse({
      structuredOutput: {
        rawFindings: [makeRawItem({ relation: 'persists', targetFindingId: 'F-0001' })],
      },
    });
    const result = await clarifyAmbiguousRawRelationsOnce({
      stepName: 'coding-review',
      persona: 'coding-reviewer',
      response,
      ledger: makeLedger(),
      agentOptions: { provider: 'claude' },
      normalize: identityNormalize,
    });
    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(result.response).toBe(response);
    expect(result.clarification).toBeUndefined();
  });
});

describe('clarifyAmbiguousRawRelationsOnce: 再生成契約 (codex B5 / 設計書 §12-4)', () => {
  const originalRaw = makeRawItem();
  const bystanderRaw = makeRawItem({
    rawFindingId: 'raw-other',
    familyTag: 'bug',
    severity: 'medium',
    title: 'An unrelated problem',
    location: 'src/other.ts:3',
    description: 'Something else entirely.',
  });

  function makeTwoRawResponse(): AgentResponse {
    return {
      persona: 'coding-reviewer',
      status: 'done',
      content: 'Review report body.',
      structuredOutput: { rawFindings: [originalRaw, bystanderRaw] },
      sessionId: 'session-1',
      timestamp: new Date('2026-06-13T00:00:01.000Z'),
    };
  }

  const identityNormalize = (response: AgentResponse): { response: AgentResponse; invalidDetail?: string } => ({ response });

  async function runWithRegeneratedRawFindings(rawFindings: unknown[]): Promise<{ response: AgentResponse }> {
    executeAgentMock.mockReset();
    executeAgentMock.mockResolvedValueOnce({
      persona: 'coding-reviewer',
      status: 'done',
      content: '',
      structuredOutput: { rawFindings },
      timestamp: new Date('2026-06-13T00:00:02.000Z'),
    });
    return clarifyAmbiguousRawRelationsOnce({
      stepName: 'coding-review',
      persona: 'coding-reviewer',
      response: makeTwoRawResponse(),
      ledger: makeLedger(),
      agentOptions: { provider: 'claude' },
      normalize: identityNormalize,
    });
  }

  it('対象 raw の relation/targetFindingId のみの変更は採用される', async () => {
    const result = await runWithRegeneratedRawFindings([
      { ...originalRaw, relation: 'persists', targetFindingId: 'F-0001' },
      bystanderRaw,
    ]);
    expect((result.response.structuredOutput?.rawFindings as Array<{ relation: string }>)[0]?.relation).toBe('persists');
  });

  it('raw の欠落は破棄して元出力を保持する', async () => {
    const original = makeTwoRawResponse();
    const result = await runWithRegeneratedRawFindings([
      { ...originalRaw, relation: 'persists', targetFindingId: 'F-0001' },
      // bystanderRaw が消えた
    ]);
    expect(result.response.structuredOutput).toEqual(original.structuredOutput);
  });

  it('raw の追加は破棄して元出力を保持する', async () => {
    const original = makeTwoRawResponse();
    const result = await runWithRegeneratedRawFindings([
      { ...originalRaw, relation: 'persists', targetFindingId: 'F-0001' },
      bystanderRaw,
      { ...bystanderRaw, rawFindingId: 'raw-smuggled', title: 'A smuggled-in extra finding' },
    ]);
    expect(result.response.structuredOutput).toEqual(original.structuredOutput);
  });

  it('非対象 raw の内容変更は破棄して元出力を保持する', async () => {
    const original = makeTwoRawResponse();
    const result = await runWithRegeneratedRawFindings([
      { ...originalRaw, relation: 'persists', targetFindingId: 'F-0001' },
      { ...bystanderRaw, description: 'Rewritten description of the unrelated problem.' },
    ]);
    expect(result.response.structuredOutput).toEqual(original.structuredOutput);
  });

  it('非対象 raw の relation 変更は破棄して元出力を保持する', async () => {
    const original = makeTwoRawResponse();
    const result = await runWithRegeneratedRawFindings([
      { ...originalRaw, relation: 'persists', targetFindingId: 'F-0001' },
      { ...bystanderRaw, relation: 'persists', targetFindingId: 'F-0001' },
    ]);
    expect(result.response.structuredOutput).toEqual(original.structuredOutput);
  });

  it('対象 raw の内容（title 等）の変更は破棄して元出力を保持する', async () => {
    const original = makeTwoRawResponse();
    const result = await runWithRegeneratedRawFindings([
      { ...originalRaw, relation: 'persists', targetFindingId: 'F-0001', title: 'A rewritten title' },
      bystanderRaw,
    ]);
    expect(result.response.structuredOutput).toEqual(original.structuredOutput);
  });

  it('executeAgent の例外時は元出力を保持してステップを失敗させない（clarification は残す）', async () => {
    executeAgentMock.mockReset();
    executeAgentMock.mockRejectedValueOnce(new Error('provider crashed mid-call'));
    const original = makeTwoRawResponse();
    const result = await clarifyAmbiguousRawRelationsOnce({
      stepName: 'coding-review',
      persona: 'coding-reviewer',
      response: original,
      ledger: makeLedger(),
      agentOptions: { provider: 'claude' },
      normalize: identityNormalize,
    });
    expect(result.response).toBe(original);
    expect(result.clarification).toBeDefined();
  });
});

describe('buildRelationCoherenceRegenerationInstruction', () => {
  it('矛盾した raw と対象 finding の対応、および全量再出力・relation/target 限定の要求を含む', () => {
    const instruction = buildRelationCoherenceRegenerationInstruction([{
      rawFindingId: 'raw-new',
      title: 'Secret is logged',
      location: 'src/secret.ts:40',
      codes: ['new-collides-open-finding'],
      collidingFindingId: 'F-0001',
      collidingFindingTitle: 'Secret is logged',
    }]);
    expect(instruction).toContain('raw-new');
    expect(instruction).toContain('F-0001');
    expect(instruction).toContain('persists');
    expect(instruction).toContain('reopened');
    expect(instruction).toContain('ALL raw findings');
    expect(instruction).toContain('ONLY the relation and targetFindingId');
  });
});
