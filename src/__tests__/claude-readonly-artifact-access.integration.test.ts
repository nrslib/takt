import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk';
import { buildSdkOptions } from '../infra/claude/options-builder.js';
import {
  createClaudeCliReadonlyArtifactHook,
  isReadonlyArtifactReadAllowed,
  resolveReadonlyArtifactReadPaths,
} from '../infra/claude/readonly-artifact-access.js';

describe('Claude readonly artifact read boundary', () => {
  it('allows only existing verification files in SDK and executed CLI hooks', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-claude-readonly-artifact-'));
    const artifacts = join(cwd, '.takt', 'runs', 'verify-current');
    const artifactsDirectory = join(artifacts, 'specs');
    mkdirSync(artifactsDirectory, { recursive: true });
    const specificationPath = join(artifactsDirectory, 'spec.qnt');
    const unrelatedPath = join(cwd, 'secrets.txt');
    const symlinkPath = join(artifactsDirectory, 'outside-link.txt');
    writeFileSync(specificationPath, 'module verify {}');
    writeFileSync(unrelatedPath, 'not a verification artifact');
    symlinkSync(unrelatedPath, symlinkPath);

    try {
      const options = {
        cwd,
        internalAgentIsolation: 'strict-readonly' as const,
        allowReadonlyFileRead: true,
        readonlyFileReadPaths: [specificationPath],
        allowedTools: ['Read'],
        permissionMode: 'readonly' as const,
      };
      const resolvedPaths = resolveReadonlyArtifactReadPaths(options);
      expect(resolvedPaths).toEqual([realpathSync(specificationPath)]);
      expect(resolveReadonlyArtifactReadPaths({ ...options, readonlyFileReadPaths: [] })).toEqual([]);
      expect(resolveReadonlyArtifactReadPaths({ ...options, readonlyFileReadPaths: ['  '] })).toEqual([]);
      expect(resolveReadonlyArtifactReadPaths({
        ...options,
        readonlyFileReadPaths: [specificationPath, join(cwd, 'missing.txt')],
      })).toEqual([]);

      const sdkOptions = buildSdkOptions(options);
      expect(sdkOptions.tools).toEqual(['Read']);
      const readHook = sdkOptions.hooks?.PreToolUse?.find(({ matcher }) => matcher === 'Read')?.hooks[0];
      expect(readHook).toBeDefined();
      const invokeSdkHook = (filePath: string) => (readHook as HookCallback)(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'test-session',
          transcript_path: join(cwd, 'transcript.jsonl'),
          cwd,
          tool_name: 'Read',
          tool_input: { file_path: filePath },
          tool_use_id: 'tool-use-1',
        } as HookInput,
        'tool-use-1',
        { signal: new AbortController().signal },
      );
      expect(await invokeSdkHook(specificationPath)).toEqual({ continue: true });
      expect(await invokeSdkHook(unrelatedPath)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(await invokeSdkHook(symlinkPath)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(await invokeSdkHook('../secrets.txt')).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });

      const cliHook = createClaudeCliReadonlyArtifactHook(resolvedPaths, cwd);
      const command = cliHook.hooks[0];
      const invokeCliHook = (filePath: string) => spawnSync(
        command.command,
        [...command.args],
        {
          cwd,
          encoding: 'utf8',
          input: JSON.stringify({
            hook_event_name: 'PreToolUse',
            cwd,
            tool_name: 'Read',
            tool_input: { file_path: filePath },
          }),
        },
      );
      expect(invokeCliHook(specificationPath)).toMatchObject({ status: 0, stdout: '' });
      const denied = invokeCliHook(unrelatedPath);
      expect(denied.status).toBe(0);
      expect(JSON.parse(denied.stdout).hookSpecificOutput).toMatchObject({
        permissionDecision: 'deny',
      });
      const deniedSymlink = invokeCliHook(symlinkPath);
      expect(JSON.parse(deniedSymlink.stdout).hookSpecificOutput).toMatchObject({
        permissionDecision: 'deny',
      });
      expect(isReadonlyArtifactReadAllowed(unrelatedPath, cwd, [])).toBe(false);

      const noOptIn = buildSdkOptions({
        cwd,
        internalAgentIsolation: 'strict-readonly',
        readonlyFileReadPaths: [specificationPath],
        allowedTools: ['Read'],
        permissionMode: 'readonly',
      });
      expect(noOptIn.tools).toEqual([]);
      expect(noOptIn.hooks?.PreToolUse?.some(({ matcher }) => matcher === 'Read')).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
