/**
 * Reviewer relation coherence (design item 3, remainder): raws that arrive
 * relation "new" but collide (normalized path+title) with an open ledger
 * finding get one reviewer regeneration chance; whatever stays incoherent is
 * dropped at intake as an unsupported-raw audit record. Pure detection /
 * partition logic plus the regeneration helper with a mocked agent call.
 * The full engine path is covered in finding-conflict-adjudication-engine.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

import {
  buildRelationCoherenceRegenerationInstruction,
  detectIncoherentNewRawFindings,
  partitionRelationCoherentRawFindings,
  regenerateIncoherentNewRawRelationsOnce,
} from '../core/workflow/findings/relation-coherence.js';
import type { AgentResponse } from '../core/models/types.js';
import type { FindingLedger, FindingLedgerEntry, RawFinding } from '../core/workflow/findings/types.js';

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

function makeRaw(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    rawFindingId: 'raw-new',
    stepName: 'coding-review',
    reviewer: 'coding-review',
    familyTag: 'security',
    severity: 'high',
    title: 'Secret is logged',
    location: 'src/secret.ts:40',
    description: 'A different observation of token logging.',
    relation: 'new',
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

describe('detectIncoherentNewRawFindings', () => {
  it('relation=new かつ正規化 path+title が open finding と一致する raw を検出する（行番号差は無視）', () => {
    const mismatches = detectIncoherentNewRawFindings([makeRaw()], [makeOpenFinding()]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ rawFindingId: 'raw-new', matchedFindingId: 'F-0001' });
  });

  it('description まで一致する raw は検出しない（decision-assembly が決定的に same へ畳むため）', () => {
    const raw = makeRaw({ description: 'The code logs a token.' });
    expect(detectIncoherentNewRawFindings([raw], [makeOpenFinding()])).toHaveLength(0);
  });

  it('relation が persists/reopened/resolution_confirmation の raw は対象外', () => {
    const raws = [
      makeRaw({ rawFindingId: 'raw-p', relation: 'persists', targetFindingId: 'F-0001' }),
      makeRaw({ rawFindingId: 'raw-r', relation: 'reopened', targetFindingId: 'F-0001' }),
      makeRaw({ rawFindingId: 'raw-c', relation: 'resolution_confirmation', targetFindingId: 'F-0001' }),
    ];
    expect(detectIncoherentNewRawFindings(raws, [makeOpenFinding()])).toHaveLength(0);
  });

  it('path または title が一致しない raw は検出しない', () => {
    const raws = [
      makeRaw({ rawFindingId: 'raw-other-path', location: 'src/other.ts:12' }),
      makeRaw({ rawFindingId: 'raw-other-title', title: 'A completely different issue' }),
    ];
    expect(detectIncoherentNewRawFindings(raws, [makeOpenFinding()])).toHaveLength(0);
  });

  it('open でない finding とは衝突しない', () => {
    const resolved = makeOpenFinding({ status: 'resolved', lifecycle: 'resolved' });
    expect(detectIncoherentNewRawFindings([makeRaw()], [resolved])).toHaveLength(0);
  });
});

describe('partitionRelationCoherentRawFindings', () => {
  it('不整合 raw を rejected（衝突相手を targetFindingId に記録）へ、他は admitted へ分ける', () => {
    const incoherent = makeRaw();
    const coherent = makeRaw({ rawFindingId: 'raw-fine', title: 'Another problem', location: 'src/other.ts:5' });
    const result = partitionRelationCoherentRawFindings({
      previousLedger: makeLedger(),
      rawFindings: [incoherent, coherent],
    });
    expect(result.admitted.map((raw) => raw.rawFindingId)).toEqual(['raw-fine']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({ rawFindingId: 'raw-new', targetFindingId: 'F-0001' });
    expect(result.rejected[0]!.evidence).toContain('not adopted as a new finding');
  });

  it('不整合が無ければ全量 admitted', () => {
    const result = partitionRelationCoherentRawFindings({
      previousLedger: makeLedger(),
      rawFindings: [makeRaw({ relation: 'persists', targetFindingId: 'F-0001' })],
    });
    expect(result.admitted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });
});

describe('regenerateIncoherentNewRawRelationsOnce', () => {
  const reviewerStructuredOutput = {
    rawFindings: [{
      rawFindingId: 'raw-new',
      familyTag: 'security',
      severity: 'high',
      title: 'Secret is logged',
      location: 'src/secret.ts:40',
      description: 'A different observation of token logging.',
      relation: 'new',
      targetFindingId: '',
      kind: 'issue',
      suggestion: '',
    }],
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

  it('1回で直れば再生成出力を採用する（本文は元のまま、structured output だけ差し替え）', async () => {
    executeAgentMock.mockReset();
    const correctedOutput = {
      rawFindings: [{
        ...reviewerStructuredOutput.rawFindings[0]!,
        relation: 'persists',
        targetFindingId: 'F-0001',
      }],
    };
    executeAgentMock.mockResolvedValueOnce({
      persona: 'coding-reviewer',
      status: 'done',
      content: JSON.stringify(correctedOutput),
      structuredOutput: correctedOutput,
      sessionId: 'session-2',
      timestamp: new Date('2026-06-13T00:00:02.000Z'),
    });

    const result = await regenerateIncoherentNewRawRelationsOnce({
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
    expect(result.content).toBe('Review report body.');
    expect(result.structuredOutput).toEqual(correctedOutput);
    expect(result.sessionId).toBe('session-2');
  });

  it('再生成出力が不正なら元の応答を保持する（ステップは失敗させない）', async () => {
    executeAgentMock.mockReset();
    executeAgentMock.mockResolvedValueOnce({
      persona: 'coding-reviewer',
      status: 'done',
      content: 'not json',
      timestamp: new Date('2026-06-13T00:00:02.000Z'),
    });

    const original = makeResponse();
    const result = await regenerateIncoherentNewRawRelationsOnce({
      stepName: 'coding-review',
      persona: 'coding-reviewer',
      response: original,
      ledger: makeLedger(),
      agentOptions: { provider: 'claude' },
      normalize: (response) => ({ response, invalidDetail: 'schema validation failed' }),
    });

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(original);
  });

  it('不整合が無ければ再生成呼び出しをしない', async () => {
    executeAgentMock.mockReset();
    const response = makeResponse({
      structuredOutput: {
        rawFindings: [{
          ...reviewerStructuredOutput.rawFindings[0]!,
          relation: 'persists',
          targetFindingId: 'F-0001',
        }],
      },
    });
    const result = await regenerateIncoherentNewRawRelationsOnce({
      stepName: 'coding-review',
      persona: 'coding-reviewer',
      response,
      ledger: makeLedger(),
      agentOptions: { provider: 'claude' },
      normalize: identityNormalize,
    });
    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(result).toBe(response);
  });
});

describe('regenerateIncoherentNewRawRelationsOnce: 再生成契約 (codex B5)', () => {
  const originalRaw = {
    rawFindingId: 'raw-new',
    familyTag: 'security',
    severity: 'high',
    title: 'Secret is logged',
    location: 'src/secret.ts:40',
    description: 'A different observation of token logging.',
    relation: 'new',
    targetFindingId: '',
    kind: 'issue',
    suggestion: '',
  };
  const bystanderRaw = {
    rawFindingId: 'raw-other',
    familyTag: 'bug',
    severity: 'medium',
    title: 'An unrelated problem',
    location: 'src/other.ts:3',
    description: 'Something else entirely.',
    relation: 'new',
    targetFindingId: '',
    kind: 'issue',
    suggestion: '',
  };

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

  async function runWithRegeneratedRawFindings(rawFindings: unknown[]): Promise<AgentResponse> {
    executeAgentMock.mockReset();
    executeAgentMock.mockResolvedValueOnce({
      persona: 'coding-reviewer',
      status: 'done',
      content: '',
      structuredOutput: { rawFindings },
      timestamp: new Date('2026-06-13T00:00:02.000Z'),
    });
    return regenerateIncoherentNewRawRelationsOnce({
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
    expect((result.structuredOutput?.rawFindings as Array<{ relation: string }>)[0]?.relation).toBe('persists');
  });

  it('raw の欠落は破棄して元出力を保持する', async () => {
    const original = makeTwoRawResponse();
    const result = await runWithRegeneratedRawFindings([
      { ...originalRaw, relation: 'persists', targetFindingId: 'F-0001' },
      // bystanderRaw が消えた
    ]);
    expect(result.structuredOutput).toEqual(original.structuredOutput);
  });

  it('raw の追加は破棄して元出力を保持する', async () => {
    const original = makeTwoRawResponse();
    const result = await runWithRegeneratedRawFindings([
      { ...originalRaw, relation: 'persists', targetFindingId: 'F-0001' },
      bystanderRaw,
      { ...bystanderRaw, rawFindingId: 'raw-smuggled', title: 'A smuggled-in extra finding' },
    ]);
    expect(result.structuredOutput).toEqual(original.structuredOutput);
  });

  it('非対象 raw の内容変更は破棄して元出力を保持する', async () => {
    const original = makeTwoRawResponse();
    const result = await runWithRegeneratedRawFindings([
      { ...originalRaw, relation: 'persists', targetFindingId: 'F-0001' },
      { ...bystanderRaw, description: 'Rewritten description of the unrelated problem.' },
    ]);
    expect(result.structuredOutput).toEqual(original.structuredOutput);
  });

  it('非対象 raw の relation 変更は破棄して元出力を保持する', async () => {
    const original = makeTwoRawResponse();
    const result = await runWithRegeneratedRawFindings([
      { ...originalRaw, relation: 'persists', targetFindingId: 'F-0001' },
      { ...bystanderRaw, relation: 'persists', targetFindingId: 'F-0001' },
    ]);
    expect(result.structuredOutput).toEqual(original.structuredOutput);
  });

  it('対象 raw の内容（title 等）の変更は破棄して元出力を保持する', async () => {
    const original = makeTwoRawResponse();
    const result = await runWithRegeneratedRawFindings([
      { ...originalRaw, relation: 'persists', targetFindingId: 'F-0001', title: 'A rewritten title' },
      bystanderRaw,
    ]);
    expect(result.structuredOutput).toEqual(original.structuredOutput);
  });

  it('executeAgent の例外時は元出力を保持してステップを失敗させない', async () => {
    executeAgentMock.mockReset();
    executeAgentMock.mockRejectedValueOnce(new Error('provider crashed mid-call'));
    const original = makeTwoRawResponse();
    const result = await regenerateIncoherentNewRawRelationsOnce({
      stepName: 'coding-review',
      persona: 'coding-reviewer',
      response: original,
      ledger: makeLedger(),
      agentOptions: { provider: 'claude' },
      normalize: identityNormalize,
    });
    expect(result).toBe(original);
  });
});

describe('buildRelationCoherenceRegenerationInstruction', () => {
  it('衝突した raw と finding の対応、および全量再出力の要求を含む', () => {
    const instruction = buildRelationCoherenceRegenerationInstruction([{
      rawFindingId: 'raw-new',
      title: 'Secret is logged',
      location: 'src/secret.ts:40',
      matchedFindingId: 'F-0001',
      matchedFindingTitle: 'Secret is logged',
    }]);
    expect(instruction).toContain('raw-new');
    expect(instruction).toContain('F-0001');
    expect(instruction).toContain('persists');
    expect(instruction).toContain('reopened');
    expect(instruction).toContain('ALL raw findings');
  });
});
