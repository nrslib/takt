import { Buffer } from 'node:buffer';
import { closeSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const runtimeDiagnosticToken = (() => {
  try {
    return readFileSync(4, 'utf8');
  } finally {
    closeSync(4);
  }
})();
if (!/^[0-9a-f]{64}$/u.test(runtimeDiagnosticToken)) process.exit(70);

const runtimeBootModule = pathToFileURL(process.env.TAKT_DSH_RUNTIME_BOOT_MODULE).href;
const npmPluginEntrypoints = JSON.parse(process.env.TAKT_DSH_NPM_PLUGIN_ENTRYPOINTS);

function instrumentRuntimeBootModule(source) {
  const auditDeclaration = 'async function auditStartupEntries(ctx, binName, warn = (line) => void process.stderr.write(line)) {';
  const auditFailures = 'const failures = await inactiveEntries(ctx);';
  const bootDeclaration = 'async function boot(binName, absoluteConfigPath, patches, prepare, bareModuleBaseUrl) {';
  const startupAuditCall = 'await auditStartupEntries(ctx, binName);';
  const auditExportAnchor = '/**\n* Boot the Loader against';
  const uniqueIndex = (value, search) => {
    const first = value.indexOf(search);
    if (first === -1 || value.indexOf(search, first + search.length) !== -1) {
      throw new Error('DeepSeek Harness boot module does not match the expected startup audit contract');
    }
    return first;
  };
  const auditDeclarationIndex = uniqueIndex(source, auditDeclaration);
  const declarationIndex = uniqueIndex(source, bootDeclaration);
  const auditIndex = uniqueIndex(source, startupAuditCall);
  const auditFailuresIndex = source.indexOf(auditFailures, auditDeclarationIndex + auditDeclaration.length);
  if (auditFailuresIndex === -1
    || auditFailuresIndex > declarationIndex
    || auditIndex < declarationIndex
    || source.includes('__taktDsh')) {
    throw new Error('DeepSeek Harness boot module does not match the expected startup audit contract');
  }

  const diagnosticPrelude = `import { writeSync as __taktDshWriteSyncImport } from 'node:fs';
const __taktDshWriteSync = __taktDshWriteSyncImport;
const __taktDshStringify = JSON.stringify;
const __taktDshCreateObject = Object.create;
const __taktDshDiagnosticToken = ${JSON.stringify(runtimeDiagnosticToken)};
const __taktDshNpmPluginEntrypoints = Object.freeze(${JSON.stringify(npmPluginEntrypoints)});
function __taktDshReportAuditFailures(failures) {
  for (let index = 0; index < failures.length; index += 1) {
    const { entry, outcome } = failures[index];
    if (outcome.kind !== 'failed') continue;
    const entrypoint = entry.options.name;
    let isNpmPluginEntrypoint = false;
    for (let entrypointIndex = 0; entrypointIndex < __taktDshNpmPluginEntrypoints.length; entrypointIndex += 1) {
      if (__taktDshNpmPluginEntrypoints[entrypointIndex] === entrypoint) {
        isNpmPluginEntrypoint = true;
        break;
      }
    }
    if (!isNpmPluginEntrypoint) continue;
    const diagnostic = __taktDshCreateObject(null);
    diagnostic.entrypoint = entrypoint;
    diagnostic.token = __taktDshDiagnosticToken;
    try {
      __taktDshWriteSync(3, __taktDshStringify(diagnostic) + '\\n');
    } catch {
      // FD 3 is an observer channel; failure must not change DSH startup behavior.
    }
    return;
  }
}
let __taktDshPrimaryBootStarted = false;
`;
  const withDiagnosticPrelude = `${diagnosticPrelude}${source}`;
  const auditDeclarationReplacement = `${auditDeclaration.slice(0, -3).replace('auditStartupEntries', '__taktDshAuditStartupEntries')}, __taktDshPrimaryBoot = false) {`;
  const withAuditParameter = withDiagnosticPrelude.replace(auditDeclaration, auditDeclarationReplacement);
  const auditFunctionIndex = uniqueIndex(withAuditParameter, auditDeclarationReplacement);
  const auditFailureIndex = withAuditParameter.indexOf(auditFailures, auditFunctionIndex + auditDeclarationReplacement.length);
  if (auditFailureIndex === -1 || auditFailureIndex > uniqueIndex(withAuditParameter, bootDeclaration)) {
    throw new Error('DeepSeek Harness boot module does not match the expected startup audit contract');
  }
  const withAuditReporting = withAuditParameter.slice(0, auditFailureIndex)
    + `${auditFailures}\n  if (__taktDshPrimaryBoot) __taktDshReportAuditFailures(failures);`
    + withAuditParameter.slice(auditFailureIndex + auditFailures.length);
  const auditExportIndex = uniqueIndex(withAuditReporting, auditExportAnchor);
  const publicAuditWrapper = `${auditDeclaration}
  return __taktDshAuditStartupEntries(ctx, binName, warn);
}
`;
  const withPublicAudit = withAuditReporting.slice(0, auditExportIndex)
    + `${publicAuditWrapper}\n`
    + withAuditReporting.slice(auditExportIndex);
  const primaryBootDeclaration = `${bootDeclaration}\n  const __taktDshPrimaryBoot = !__taktDshPrimaryBootStarted;\n  __taktDshPrimaryBootStarted = true;`;
  const bootIndex = uniqueIndex(withPublicAudit, bootDeclaration);
  const withPrimaryBoot = withPublicAudit.slice(0, bootIndex)
    + primaryBootDeclaration
    + withPublicAudit.slice(bootIndex + bootDeclaration.length);
  const finalAuditIndex = uniqueIndex(withPrimaryBoot, startupAuditCall);
  const auditReplacement = 'await __taktDshAuditStartupEntries(ctx, binName, (line) => void process.stderr.write(line), __taktDshPrimaryBoot);';
  return withPrimaryBoot.slice(0, finalAuditIndex)
    + auditReplacement
    + withPrimaryBoot.slice(finalAuditIndex + startupAuditCall.length);
}

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== runtimeBootModule) return loaded;
    if (loaded.format !== 'module' || loaded.source === undefined || loaded.source === null) {
      throw new Error('DeepSeek Harness boot module source is unavailable');
    }
    const source = typeof loaded.source === 'string'
      ? loaded.source
      : Buffer.from(loaded.source).toString('utf8');
    return { ...loaded, source: instrumentRuntimeBootModule(source) };
  },
});
