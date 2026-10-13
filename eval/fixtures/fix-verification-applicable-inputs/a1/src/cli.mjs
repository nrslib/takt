import { encodeAudio } from './encoder.mjs';

export function runCli(args, environment, cwd) {
  if (args.length !== 2) throw new Error('Usage: sound-export input output');
  return encodeAudio(args[0], args[1], environment, cwd);
}
