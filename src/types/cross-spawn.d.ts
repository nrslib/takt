declare module 'cross-spawn' {
  import type {
    ChildProcess,
    SpawnOptions,
    SpawnSyncOptions,
    SpawnSyncReturns,
  } from 'node:child_process';

  interface CrossSpawn {
    (command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
    spawn: CrossSpawn;
    sync(command: string, args?: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<Buffer>;
  }

  const crossSpawn: CrossSpawn;
  export = crossSpawn;
}
