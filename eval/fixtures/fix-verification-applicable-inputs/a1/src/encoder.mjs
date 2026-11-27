import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function encodeAudio(input, output, environment, cwd) {
  let executable;
  for (const directory of environment.PATH.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, 'audio-encode');
    try {
      accessSync(candidate, constants.X_OK);
      executable = candidate;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
    }
  }
  if (executable === undefined) throw new Error('Encoder unavailable');
  const args = ['--input', input, '--output', output];
  const result = spawnSync(executable, args, { cwd, env: environment, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Encoder exited with ${result.status}`);
  return result.stdout;
}
