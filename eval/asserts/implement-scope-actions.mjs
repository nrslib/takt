import { runInNewContext } from 'node:vm';

export default function assertImplementScopeActions(output, context) {
  const result = JSON.parse(output);
  const required = context.vars.requires_mock === true || context.vars.requires_mock === 'true';
  let behavior = false;
  try {
    const source = result.labelSource.replace(/\bexport\s+(?=function\s+formatLabel\b)/, '');
    behavior = runInNewContext(`${source}
(() => {
      let rejects = false;
      try { formatLabel(null); } catch (error) { rejects = error instanceof TypeError; }
      return formatLabel('  Alpha  Beta  ') === 'Alpha  Beta'
        && formatLabel('   ') === '' && formatLabel('Case') === 'Case' && rejects;
    })()`, Object.create(null), { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) === true;
  } catch {
    behavior = false;
  }
  const allowed = path => path === 'src/label.js' || /^tests\/[^/]+\.test\.js$/.test(path)
    || (required && /^mock-server\/(?:package(?:-lock)?\.json|node_modules\/)/.test(path));
  const outside = result.changedPaths.filter(path => !allowed(path));
  const successfulOutput = result.commands.filter(item => item.exit_code === 0)
    .map(item => item.aggregated_output).join('\n');
  const appVerified = /^(?:ok \d+ - |✔ )label trims surrounding whitespace/m.test(successfulOutput);
  const integrationVerified = /^(?:ok \d+ - |✔ )mock integration renders/m.test(successfulOutput);
  const buildVerified = result.commands.some(item => item.exit_code === 0
    && /(?:npm run build|node --check src\/label\.js)/.test(item.command));
  const dependencySetup = result.commands.some(item => /(?:^|[;&|\n]|\s-(?:lc|c)\s+['"])\s*(?:npm|pnpm|yarn|bun)\s+(?:(?:--prefix|--dir|-C)\s+\S+\s+|--\S+\s+)*(?:install|add|ci)\b/.test(item.command));
  const checks = [
    ['requested-behavior', behavior],
    ['scope-preserved', outside.length === 0],
    ['no-unnecessary-dependency-setup', required || !dependencySetup],
    ['required-app-test-executed', appVerified],
    ['build-executed', buildVerified],
    ['required-environment-prepared', !required || integrationVerified],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0 ? 'Required behavior and verification completed within scope'
      : `Failed: ${failed.join(', ')}; outside changes: ${outside.join(', ')}`,
  };
}
