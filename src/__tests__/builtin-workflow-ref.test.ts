import { describe, expect, it } from 'vitest';
import { buildBuiltinWorkflowRef } from '../shared/workflowConfigMetadata.js';

describe('builtin workflow identity', () => {
  it('identifies identical relative locations and content consistently', () => {
    const ref = buildBuiltinWorkflowRef('ja/workflows/default.yaml', 'instruction: Implement v1');

    expect(ref).toMatch(/^builtin:v2:sha256:[a-f0-9]{64}$/);
    expect(buildBuiltinWorkflowRef('ja/workflows/default.yaml', 'instruction: Implement v1')).toBe(ref);
  });

  it.each(['en/workflows/default.yaml', 'ja/workflows/nested/default.yaml'])(
    'distinguishes the logical location %s from ja/workflows/default.yaml', (relativePath) => {
      expect(buildBuiltinWorkflowRef(relativePath, 'instruction: Implement v1'))
        .not.toBe(buildBuiltinWorkflowRef('ja/workflows/default.yaml', 'instruction: Implement v1'));
    },
  );

  it('changes identity when only the instruction content changes', () => {
    expect(buildBuiltinWorkflowRef('ja/workflows/default.yaml', 'instruction: Implement v2'))
      .not.toBe(buildBuiltinWorkflowRef('ja/workflows/default.yaml', 'instruction: Implement v1'));
  });
});
