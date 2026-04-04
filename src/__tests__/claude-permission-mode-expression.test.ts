import { describe, expect, it } from 'vitest';
import { taktPermissionModeToClaudeExpression } from '../infra/claude/permission-mode-expression.js';

describe('taktPermissionModeToClaudeExpression (SDK + headless DRY)', () => {
  it('maps readonly to default', () => {
    expect(taktPermissionModeToClaudeExpression('readonly')).toBe('default');
  });

  it('maps edit to acceptEdits', () => {
    expect(taktPermissionModeToClaudeExpression('edit')).toBe('acceptEdits');
  });

  it('maps full to bypassPermissions', () => {
    expect(taktPermissionModeToClaudeExpression('full')).toBe('bypassPermissions');
  });
});
