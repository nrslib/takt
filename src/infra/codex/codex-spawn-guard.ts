/**
 * Guards the Codex SDK's internal `child_process.spawn` against unhandled
 * 'error' events on stdio streams.
 *
 * The SDK spawns the Codex CLI binary and writes the turn input to the
 * child's stdin immediately. When the child exits before the write completes,
 * the write fails with EPIPE and the 'error' event on stdin has no listener,
 * crashing the host process. The SDK only attaches an 'error' listener to
 * the ChildProcess itself, not to its stdio streams.
 *
 * This module patches `child_process.spawn` at the CJS module layer and
 * synchronizes Node's ESM built-in bindings. The wrapper only activates for
 * Codex binary names or the SDK's argument and environment markers; every
 * other spawn passes through untouched.
 *
 * For matching spawns, `guardChildProcessStreams` attaches 'error' listeners
 * on the process and each stdio stream. The guard logs and swallows the
 * error, terminates the child when a stream fails, and tears down listeners
 * on child close. The SDK can then surface `Codex Exec exited with ...`
 * through the existing provider-error classification.
 */

import { basename } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { guardChildProcessStreams } from '../../shared/utils/child-process-guard.js';
import { createLogger } from '../../shared/utils/debug.js';

const log = createLogger('codex-spawn-guard');

const CODEX_BINARY_BASENAMES = new Set(['codex', 'codex.exe', 'codex.cmd']);
const CODEX_SDK_ARGUMENT_PREFIX = ['exec', '--experimental-json'] as const;
const CODEX_SDK_ORIGINATOR_ENV = 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE';

type SpawnFn = (
  command: string,
  argsOrOptions?: readonly string[] | SpawnOptions,
  options?: SpawnOptions,
) => ChildProcess;

let installed = false;

function isArgumentList(
  value: readonly string[] | SpawnOptions | undefined,
): value is readonly string[] {
  return Array.isArray(value);
}

function isCodexSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions | undefined,
): boolean {
  const commandBasename = basename(command).toLowerCase();
  return CODEX_BINARY_BASENAMES.has(commandBasename)
    || (args[0] === CODEX_SDK_ARGUMENT_PREFIX[0]
      && args[1] === CODEX_SDK_ARGUMENT_PREFIX[1]
      && options?.env !== undefined
      && Object.hasOwn(options.env, CODEX_SDK_ORIGINATOR_ENV));
}

export function installCodexSpawnGuard(): void {
  if (installed) {
    return;
  }
  const require = createRequire(import.meta.url);
  const childProcessModule = require('node:child_process') as {
    spawn: SpawnFn;
  };
  const originalSpawn = childProcessModule.spawn;

  const guardedSpawn: SpawnFn = (command, argsOrOptions, options) => {
    const child = originalSpawn(command, argsOrOptions, options);
    const args = isArgumentList(argsOrOptions) ? argsOrOptions : [];
    if (!isCodexSpawn(command, args, options)) {
      return child;
    }

    let streamFailureHandled = false;
    const teardown = guardChildProcessStreams(child, (error, source) => {
      log.debug('Swallowed stdio error from Codex child process', {
        source,
        message: error.message,
        code: (error as NodeJS.ErrnoException).code,
      });

      if (source === 'process' || streamFailureHandled) {
        return;
      }
      streamFailureHandled = true;
      if (child.exitCode !== null || child.signalCode !== null || child.killed) {
        return;
      }
      try {
        child.kill();
      } catch (killError) {
        log.debug('Failed to terminate Codex child after stdio error', {
          message: killError instanceof Error ? killError.message : String(killError),
        });
      }
    });

    let settled = false;
    const finalize = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      teardown();
    };
    const onClose = (): void => finalize();
    const onError = (): void => finalize();
    child.on('close', onClose);
    child.on('error', onError);

    return child;
  };

  childProcessModule.spawn = guardedSpawn;
  syncBuiltinESMExports();
  installed = true;
}

installCodexSpawnGuard();
