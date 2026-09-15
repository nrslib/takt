import { runInNewContext } from 'node:vm';

const APP_COMMANDS = ['npm run test:app', 'npm test', 'node --test tests/label.test.js'];
const INTEGRATION_COMMANDS = ['npm run test:integration', 'npm test', 'node --test mock-server/tests/fixture.test.js'];
const BUILD_COMMANDS = ['npm run build', 'node --check src/label.js'];
const CHECK_COMMANDS = new Set([...APP_COMMANDS, ...INTEGRATION_COMMANDS, ...BUILD_COMMANDS]);

function executedCheck(item, expectedCommands) {
  if (item.exit_code !== 0) return false;
  // Accept fixture runners directly or inside the shell wrapper recorded by Codex.
  // Restrict chains to successful checks so quoted text and recovery commands cannot pass.
  const wrapped = item.command.match(/^(?:\/bin\/)?(?:bash|zsh|sh) -l?c (['"])(.*)\1$/s);
  const commands = (wrapped ? wrapped[2] : item.command).split('&&').map(command => command.trim());
  return commands.every(command => CHECK_COMMANDS.has(command))
    && commands.some(command => expectedCommands.includes(command));
}

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
  const appVerified = result.commands.some(item => executedCheck(item, APP_COMMANDS)
    && /^(?:ok \d+ - |✔ )label trims surrounding whitespace/m.test(item.aggregated_output));
  const integrationVerified = result.commands.some(item => executedCheck(item, INTEGRATION_COMMANDS)
    && /^(?:ok \d+ - |✔ )mock integration renders/m.test(item.aggregated_output));
  const buildVerified = result.commands.some(item => executedCheck(item, BUILD_COMMANDS));
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
