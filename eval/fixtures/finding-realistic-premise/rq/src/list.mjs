import childProcess from 'node:child_process';

export function listFiles(root) {
  const output = childProcess.execFileSync('git', ['ls-files', 'notes/'], {
    cwd: root,
    encoding: 'utf8',
  });
  return output.split('\n').filter(line => line.length > 0).join('\n');
}
