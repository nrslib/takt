#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '..');
const managedEnvironmentDirectory = join('src', 'infra', 'deepseek-harness');
const requiredConstants = [
  'DEEPSEEK_HARNESS_PYTHON_VERSION',
  'DEEPSEEK_HARNESS_PYTHON_REQUIRES',
  'DEEPSEEK_HARNESS_SDK_VERSION',
  'DEEPSEEK_HARNESS_RUNTIME_VERSION',
  'DEEPSEEK_HARNESS_MIN_UV_VERSION',
];
const managedPackages = [
  {
    name: 'deepseek-harness-sdk',
    constantName: 'DEEPSEEK_HARNESS_SDK_VERSION',
  },
  {
    name: 'deepseek-harness-runtime-bin',
    constantName: 'DEEPSEEK_HARNESS_RUNTIME_VERSION',
  },
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function readRequiredConstants(constantsPath) {
  const source = readFileSync(constantsPath, 'utf8');
  const constants = new Map();
  for (const match of source.matchAll(/^export const (DEEPSEEK_HARNESS_[A-Z_]+) = '([^']*)';$/gmu)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      constants.set(name, value);
    }
  }

  const values = {};
  for (const name of requiredConstants) {
    const value = constants.get(name);
    if (value === undefined) {
      throw new Error(`Missing ${name} in ${constantsPath}`);
    }
    values[name] = value;
  }
  return values;
}

function readTomlString(source, key) {
  const match = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]*)"$`, 'mu').exec(source);
  return match?.[1];
}

function requireTomlString(source, key, filePath) {
  const value = readTomlString(source, key);
  if (value === undefined) {
    throw new Error(`Missing ${key} in ${filePath}`);
  }
  return value;
}

function readDependencyVersion(manifest, packageName, manifestPath) {
  const match = new RegExp(
    `"${escapeRegExp(packageName)}==([^\"]+)"`,
    'u',
  ).exec(manifest);
  if (match?.[1] === undefined) {
    throw new Error(`Missing pinned dependency ${packageName} in ${manifestPath}`);
  }
  return match[1];
}

function findLockedPackage(lock, packageName, lockPath) {
  for (const block of lock.split('[[package]]').slice(1)) {
    const name = readTomlString(block, 'name');
    if (name === packageName) {
      return block;
    }
  }
  throw new Error(`Missing locked package ${packageName} in ${lockPath}`);
}

function assertEqual(description, actual, expected) {
  if (actual !== expected) {
    const found = actual === undefined ? '(missing)' : actual;
    throw new Error(`${description} mismatch: expected ${expected}, found ${found}`);
  }
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(value.trim());
  return match === null
    ? undefined
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parsePythonVersion(value) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(value);
  return match === null
    ? undefined
    : [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function parsePythonRequiresRange(value) {
  const normalized = value.trim().replace(/\s+/gu, '');
  const minorMatch = /^(\d+)\.(\d+)$/u.exec(normalized);
  if (minorMatch !== null) {
    const major = Number(minorMatch[1]);
    const minor = Number(minorMatch[2]);
    return {
      lower: [major, minor, 0],
      upper: [major, minor + 1, 0],
    };
  }

  const wildcardMatch = /^==(\d+)\.(\d+)\.\*$/u.exec(normalized);
  if (wildcardMatch !== null) {
    const major = Number(wildcardMatch[1]);
    const minor = Number(wildcardMatch[2]);
    return {
      lower: [major, minor, 0],
      upper: [major, minor + 1, 0],
    };
  }

  const specifiers = normalized.split(',');
  if (specifiers.length !== 2) {
    return undefined;
  }

  let lower;
  let upper;
  for (const specifier of specifiers) {
    if (specifier.startsWith('>=')) {
      if (lower !== undefined) {
        return undefined;
      }
      lower = parsePythonVersion(specifier.slice(2));
    } else if (specifier.startsWith('<')) {
      if (upper !== undefined) {
        return undefined;
      }
      upper = parsePythonVersion(specifier.slice(1));
    } else {
      return undefined;
    }
  }

  return lower === undefined || upper === undefined ? undefined : { lower, upper };
}

function assertPythonMinorRequirement(description, value, fixedMinor) {
  const fixedMatch = /^(\d+)\.(\d+)$/u.exec(fixedMinor.trim());
  const range = parsePythonRequiresRange(value);
  if (fixedMatch === null || range === undefined) {
    throw new Error(
      `${description} must allow only Python minor ${fixedMinor}; found ${value}`,
    );
  }

  const major = Number(fixedMatch[1]);
  const minor = Number(fixedMatch[2]);
  const expectedLower = [major, minor, 0];
  const expectedUpper = [major, minor + 1, 0];
  if (
    compareVersions(range.lower, expectedLower) !== 0
    || compareVersions(range.upper, expectedUpper) !== 0
  ) {
    throw new Error(
      `${description} must allow only Python minor ${fixedMinor}; found ${value}`,
    );
  }
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue !== rightValue) {
      return leftValue < rightValue ? -1 : 1;
    }
  }
  return 0;
}

function readCiUvVersion(ciPath) {
  const ci = readFileSync(ciPath, 'utf8');
  const matches = [...ci.matchAll(
    /^[ \t]*-[ \t]+uses:[ \t]+astral-sh\/setup-uv@[^\n]+\n[ \t]+with:[ \t]*\n[ \t]+version:[ \t]*['"]([^'"]+)['"][ \t]*$/gmu,
  )];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error(`CI must declare one explicit astral-sh/setup-uv version in ${ciPath}`);
  }
  return matches[0][1];
}

function assertCiUvVersion(ciPath, minimumVersion) {
  const minimum = parseVersion(minimumVersion);
  if (minimum === undefined) {
    throw new Error(`Invalid minimum uv version ${minimumVersion} in constants`);
  }
  const configuredVersion = readCiUvVersion(ciPath);
  const configured = parseVersion(configuredVersion);
  if (configured === undefined) {
    throw new Error(`Invalid CI uv version ${configuredVersion} in ${ciPath}`);
  }
  if (compareVersions(configured, minimum) < 0) {
    throw new Error(
      `CI uv version ${configuredVersion} is older than the required ${minimumVersion}`,
    );
  }
}

function assertLockedMetadata(lock, packageName, version, lockPath) {
  const pattern = new RegExp(
    `\\{\\s*name\\s*=\\s*"${escapeRegExp(packageName)}",\\s*specifier\\s*=\\s*"==${escapeRegExp(version)}"\\s*\\}`,
    'u',
  );
  if (!pattern.test(lock)) {
    throw new Error(
      `uv.lock metadata for ${packageName} does not match ${version} in ${lockPath}`,
    );
  }
}

export function verifyDeepSeekHarnessContract(projectRoot = repositoryRoot) {
  const managedRoot = join(projectRoot, managedEnvironmentDirectory);
  const constantsPath = join(managedRoot, 'constants.ts');
  const manifestPath = join(managedRoot, 'pyproject.toml');
  const lockPath = join(managedRoot, 'uv.lock');
  const ciPath = join(projectRoot, '.github', 'workflows', 'ci.yml');
  const constants = readRequiredConstants(constantsPath);
  assertCiUvVersion(ciPath, constants.DEEPSEEK_HARNESS_MIN_UV_VERSION);
  const manifest = readFileSync(manifestPath, 'utf8');
  const lock = readFileSync(lockPath, 'utf8');
  const manifestPythonRequires = requireTomlString(manifest, 'requires-python', manifestPath);

  assertPythonMinorRequirement(
    'DeepSeek Harness constants requires-python',
    constants.DEEPSEEK_HARNESS_PYTHON_REQUIRES,
    constants.DEEPSEEK_HARNESS_PYTHON_VERSION,
  );
  assertPythonMinorRequirement(
    'pyproject.toml requires-python',
    manifestPythonRequires,
    constants.DEEPSEEK_HARNESS_PYTHON_VERSION,
  );
  assertEqual(
    'pyproject.toml requires-python',
    manifestPythonRequires,
    constants.DEEPSEEK_HARNESS_PYTHON_REQUIRES,
  );
  assertEqual(
    'uv.lock requires-python',
    requireTomlString(lock, 'requires-python', lockPath),
    `==${constants.DEEPSEEK_HARNESS_PYTHON_VERSION}.*`,
  );

  for (const managedPackage of managedPackages) {
    const expectedVersion = constants[managedPackage.constantName];
    const manifestVersion = readDependencyVersion(manifest, managedPackage.name, manifestPath);
    assertEqual(`pyproject.toml ${managedPackage.name}`, manifestVersion, expectedVersion);

    const packageBlock = findLockedPackage(lock, managedPackage.name, lockPath);
    assertEqual(
      `uv.lock ${managedPackage.name}`,
      requireTomlString(packageBlock, 'version', lockPath),
      expectedVersion,
    );
    assertLockedMetadata(lock, managedPackage.name, expectedVersion, lockPath);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  try {
    verifyDeepSeekHarnessContract();
    console.log('DeepSeek Harness manifest, lock, and constants are consistent.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`DeepSeek Harness contract verification failed: ${message}`);
    process.exitCode = 1;
  }
}
