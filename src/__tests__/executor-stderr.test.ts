/**
 * Tests for QueryExecutor stderr capture and SdkOptionsBuilder stderr passthrough.
 */

import { describe, it, expect } from 'vitest';
import { buildSdkOptions } from '../infra/claude/options-builder.js';
import type { ClaudeSpawnOptions } from '../infra/claude/types.js';

describe('SdkOptionsBuilder.build() — stderr', () => {
  it('should include stderr callback in SDK options when onStderr is provided', () => {
    const stderrHandler = (_data: string): void => {};
    const spawnOptions: ClaudeSpawnOptions = {
      cwd: '/tmp/test',
      onStderr: stderrHandler,
    };

    const sdkOptions = buildSdkOptions(spawnOptions);
    expect(sdkOptions.stderr).toBe(stderrHandler);
  });

  it('should not include stderr in SDK options when onStderr is not provided', () => {
    const spawnOptions: ClaudeSpawnOptions = {
      cwd: '/tmp/test',
    };

    const sdkOptions = buildSdkOptions(spawnOptions);
    expect(sdkOptions).not.toHaveProperty('stderr');
  });
});
