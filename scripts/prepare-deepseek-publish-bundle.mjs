import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Reconcile the bundled toolkit's dependency declaration with the patched resolution. */
export function prepareToolkitManifest(manifest, resolvedVersion) {
  if (manifest.name !== '@deepseek-ai/libreoffice-kit' || manifest.version !== '0.1.5') {
    throw new Error('DeepSeek office toolkit changed; review the publish dependency patch');
  }
  if (resolvedVersion !== '0.8.3') {
    throw new Error('The bundled office toolkit must resolve patched fflate 0.8.3');
  }
  if (!['0.8.2', '0.8.3'].includes(manifest.dependencies?.fflate)) {
    throw new Error('DeepSeek office fflate declaration changed; review the publish dependency patch');
  }
  return { ...manifest, dependencies: { ...manifest.dependencies, fflate: resolvedVersion } };
}

/** Validate local resolutions and prepare only the bundled toolkit metadata. */
function prepareBundle() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-sdk-client']) {
    if (!manifest.bundleDependencies?.includes(name)) {
      throw new Error('Publish the pinned DeepSeek runtime and SDK as bundled dependencies');
    }
  }
  const require = createRequire(join(root, 'package.json'));
  for (const name of manifest.bundleDependencies) {
    const installed = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.version !== manifest.dependencies[name]) {
      throw new Error(`Installed bundled dependency ${name} must match its pinned publish version`);
    }
  }
  const toolkitPath = realpathSync(require.resolve('@deepseek-ai/libreoffice-kit/package.json'));
  const packageRoot = realpathSync(join(root, 'node_modules'));
  if (packageRoot !== join(realpathSync(root), 'node_modules')) {
    throw new Error('Refusing to prepare a shared or linked node_modules directory');
  }
  const localPath = relative(packageRoot, toolkitPath);
  if (localPath.startsWith('..') || isAbsolute(localPath)) {
    throw new Error('Refusing to prepare a toolkit outside this checkout node_modules');
  }
  const toolkitRequire = createRequire(toolkitPath);
  let fflateRoot = dirname(toolkitRequire.resolve('fflate'));
  while (!existsSync(join(fflateRoot, 'package.json'))) {
    const parent = dirname(fflateRoot);
    if (parent === fflateRoot) throw new Error('Cannot verify the bundled fflate package');
    fflateRoot = parent;
  }
  const resolvedVersion = JSON.parse(readFileSync(join(fflateRoot, 'package.json'), 'utf8')).version;
  const original = JSON.parse(readFileSync(toolkitPath, 'utf8'));
  const prepared = prepareToolkitManifest(original, resolvedVersion);
  // Only our installed dependency's metadata changes. SDK/runtime code and
  // credential files are untouched; npm ci restores the upstream declaration.
  writeFileSync(toolkitPath, `${JSON.stringify(prepared, null, 2)}\n`);
  console.log('Prepared DeepSeek npm bundle with patched fflate 0.8.3');
  console.log('Source checkout metadata is now prepared for publishing. After packing (including failed or interrupted packs), run npm ci to restore upstream node_modules metadata.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) prepareBundle();
