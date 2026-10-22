import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { WorkflowStepRawSchema } from '../core/models/workflow-schemas.js';
import { isDynamicParallelSubSteps } from '../core/models/workflow-types.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

const description = '変更内容をレビューし、修正が必要な問題を報告する';
const selectionHint = '外部入力または権限にかかわる変更の場合に選ぶ';
const agent = { name: 'review', instruction: 'Review the changes' };
const call = { name: 'delegate', kind: 'workflow_call', call: 'review-suite' };
const poolCandidate = { ...agent, name: 'optional-review', description };

const stepLocations = [
  { label: '通常のステップ', step: agent },
  { label: 'system ステップ', step: { name: 'wait', kind: 'system' } },
  { label: 'workflow_call ステップ', step: call },
  {
    label: '静的な並列のエージェント',
    step: { name: 'reviews', parallel: [agent] },
  },
  {
    label: '静的な並列の workflow_call',
    step: { name: 'reviews', parallel: [call] },
  },
  {
    label: 'parallel.fixed のエージェント',
    step: { name: 'reviews', parallel: { fixed: [agent], pool: [poolCandidate] } },
  },
] as const;

function setParticipantField(
  step: Record<string, unknown>,
  field: string,
  value: unknown,
): Record<string, unknown> {
  if (Array.isArray(step.parallel)) {
    return { ...step, parallel: step.parallel.map((sub) => ({ ...sub, [field]: value })) };
  }
  if (step.parallel !== undefined) {
    const parallel = step.parallel as { fixed: Record<string, unknown>[]; pool: unknown[] };
    return {
      ...step,
      parallel: {
        ...parallel,
        fixed: parallel.fixed.map((sub) => ({ ...sub, [field]: value })),
      },
    };
  }
  return { ...step, [field]: value };
}

describe('ステップの description スキーマ', () => {
  it.each(stepLocations)('$label の description を省略できる', ({ step }) => {
    expect(WorkflowStepRawSchema.safeParse(step).success).toBe(true);
  });

  it.each(stepLocations)('$label の description を受け付けて保持する', ({ step }) => {
    const raw = setParticipantField(step, 'description', description);

    expect(WorkflowStepRawSchema.parse(raw)).toMatchObject(raw);
  });

  it.each(stepLocations)('$label の selection_hint を拒否する', ({ step }) => {
    const raw = setParticipantField(step, 'selection_hint', selectionHint);

    expect(WorkflowStepRawSchema.safeParse(raw).success).toBe(false);
  });

  it('並列の親ステップの selection_hint を拒否する', () => {
    expect(WorkflowStepRawSchema.safeParse({
      name: 'reviews',
      selection_hint: selectionHint,
      parallel: { fixed: [], pool: [poolCandidate] },
    }).success).toBe(false);
  });

  it('動的プールの候補だけで selection_hint を受け付ける', () => {
    const raw = {
      name: 'reviews',
      parallel: { pool: [{ ...poolCandidate, selection_hint: ` ${selectionHint} ` }] },
    };

    expect(WorkflowStepRawSchema.parse(raw)).toMatchObject({
      parallel: { pool: [{ description, selection_hint: selectionHint }] },
    });
  });

  it.each([undefined, '', '   ', null, 123])(
    '動的プールの無効な description（%j）を拒否する',
    (invalidDescription) => {
      expect(WorkflowStepRawSchema.safeParse({
        name: 'reviews',
        parallel: { pool: [{ ...poolCandidate, description: invalidDescription }] },
      }).success).toBe(false);
    },
  );

  it.each(['', '   ', null, 123])('無効な selection_hint（%j）を拒否する', (invalidHint) => {
    expect(WorkflowStepRawSchema.safeParse({
      name: 'reviews',
      parallel: { pool: [{ ...poolCandidate, selection_hint: invalidHint }] },
    }).success).toBe(false);
  });
});

describe('ステップの description と selection_hint の正規化', () => {
  it.each(stepLocations)('$label の description を保持する', ({ step }) => {
    const workflow = normalizeWorkflowConfig({
      name: 'descriptions',
      steps: [setParticipantField(step, 'description', description)],
    }, '/project');
    const normalized = workflow.steps[0]!;

    if (Array.isArray(normalized.parallel)) {
      expect(normalized.parallel[0]?.description).toBe(description);
    } else if (normalized.parallel !== undefined) {
      expect(normalized.parallel.fixed[0]?.description).toBe(description);
    } else {
      expect(normalized.description).toBe(description);
    }
  });

  it('動的プールの selection_hint を selectionHint として保持する', () => {
    const workflow = normalizeWorkflowConfig({
      name: 'selection-hints',
      steps: [{
        name: 'reviews',
        parallel: {
          fixed: [{ ...agent, description }],
          pool: [{ ...poolCandidate, selection_hint: selectionHint }],
        },
      }],
    }, '/project');
    const parallel = workflow.steps[0]!.parallel!;

    expect(isDynamicParallelSubSteps(parallel)).toBe(true);
    if (!isDynamicParallelSubSteps(parallel)) throw new Error('Expected dynamic parallel');
    expect(parallel.pool[0]).toMatchObject({ description, selectionHint });
    expect(parallel.pool[0]).not.toHaveProperty('selection_hint');
    expect(parallel.fixed[0]).not.toHaveProperty('selectionHint');
  });

  it('selection_hint がない既存 YAML の選択条件を description に保持する', () => {
    const raw: unknown = parseYaml(`
name: legacy-selection
steps:
  - name: reviews
    parallel:
      pool:
        - name: optional-review
          description: ${selectionHint}
          instruction: Review the changes
`);
    const workflow = normalizeWorkflowConfig(raw, '/project');
    const parallel = workflow.steps[0]!.parallel!;

    expect(isDynamicParallelSubSteps(parallel)).toBe(true);
    if (!isDynamicParallelSubSteps(parallel)) throw new Error('Expected dynamic parallel');
    expect(parallel.pool[0]?.description).toBe(selectionHint);
    expect(parallel.pool[0]).not.toHaveProperty('selectionHint');
  });
});
