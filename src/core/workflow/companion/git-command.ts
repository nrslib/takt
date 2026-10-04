export function isGitCommitCommand(command: string): boolean {
  return command.split(/&&|\|\||[;|\n]/u).some((segment) => {
    const tokens = segment.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/gu)?.map(unquoteShellToken) ?? [];
    let index = 0;
    while (tokens[index] === 'command' || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? '')) {
      index += 1;
    }
    if (tokens[index] === 'env') {
      index += 1;
      while (tokens[index] === '-i' || tokens[index] === '--ignore-environment') index += 1;
      while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? '')) index += 1;
      if (tokens[index] === '--') index += 1;
    }
    if (tokens[index] !== 'git') return false;
    index += 1;
    for (;;) {
      const option = tokens[index];
      if (!isGitGlobalOption(option)) break;
      index += gitGlobalOptionTakesValue(option) ? 2 : 1;
    }
    return tokens[index] === 'commit';
  });
}

function isGitGlobalOption(value: string | undefined): value is string {
  if (value === undefined) return false;
  return [
    '-C',
    '-c',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--config-env',
    '--bare',
    '--no-replace-objects',
    '--literal-pathspecs',
    '--no-literal-pathspecs',
    '--glob-pathspecs',
    '--noglob-pathspecs',
    '--icase-pathspecs',
    '--no-optional-locks',
    '--no-pager',
    '--paginate',
  ].includes(value) || /^--(?:git-dir|work-tree|namespace|config-env)=/u.test(value);
}

function gitGlobalOptionTakesValue(value: string): boolean {
  return ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(value);
}

function unquoteShellToken(value: string): string {
  const first = value[0];
  return (first === '"' || first === "'") && value.at(-1) === first
    ? value.slice(1, -1)
    : value;
}
