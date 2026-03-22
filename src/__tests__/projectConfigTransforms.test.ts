import { describe, expect, it } from 'vitest';

describe('projectConfigTransforms module surface', () => {
  it('formatIssuePath を再エクスポートしない', async () => {
    const transforms = await import('../infra/config/project/projectConfigTransforms.js');

    expect(Object.prototype.hasOwnProperty.call(transforms, 'formatIssuePath')).toBe(false);
  });
});
