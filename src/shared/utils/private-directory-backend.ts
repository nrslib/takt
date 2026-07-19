import type { Stats } from 'node:fs';
import {
  assertPrivateArtifactImmediateChild,
  runPrivateArtifactHelper,
  serializePrivateArtifactIdentity,
} from './private-artifact-helper.js';

const DIRECTORY_OPERATION_SCRIPT = String.raw`
const fs = require('node:fs');
const request = JSON.parse(process.argv[1]);

function assertIdentity(stat, identity, message) {
  if (!stat.isDirectory() || String(stat.dev) !== identity.dev || String(stat.ino) !== identity.ino) {
    throw new Error(message);
  }
}

function lstatOrUndefined(name) {
  try {
    return fs.lstatSync(name);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined;
    throw error;
  }
}

function openDirectory(name, identity, message) {
  if (process.platform === 'win32') {
    assertIdentity(fs.lstatSync(name), identity, message);
    return undefined;
  }
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW ?? 0)
    | (fs.constants.O_DIRECTORY ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(name, flags);
    assertIdentity(fs.fstatSync(descriptor), identity, message);
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw new Error(message, { cause: error });
  }
}

let stagingDescriptor;
let targetDescriptor;
try {
  assertIdentity(
    fs.statSync('.'),
    request.parentIdentity,
    'Private directory parent identity changed before operation',
  );
  stagingDescriptor = openDirectory(
    request.stagingName,
    request.stagingIdentity,
    'Private staging directory identity changed before operation',
  );

  if (request.operation === 'cleanup-directory') {
    if (lstatOrUndefined(request.quarantineName) !== undefined) {
      throw new Error('Private directory cleanup quarantine already exists');
    }
    fs.renameSync(request.stagingName, request.quarantineName);
    assertIdentity(
      fs.lstatSync(request.quarantineName),
      request.stagingIdentity,
      'Private staging directory identity changed during cleanup',
    );
    fs.rmSync(request.quarantineName, { recursive: true });
  } else if (request.operation === 'publish-directory') {
    if (request.targetIdentity === null) {
      if (lstatOrUndefined(request.targetName) !== undefined) {
        throw new Error('Private target directory identity changed before publication');
      }
    } else {
      targetDescriptor = openDirectory(
        request.targetName,
        request.targetIdentity,
        'Private target directory identity changed before publication',
      );
      if (fs.readdirSync(request.targetName).length !== 0) {
        throw new Error('Private target directory is not empty before publication');
      }
    }
    fs.renameSync(request.stagingName, request.targetName);
    assertIdentity(
      fs.lstatSync(request.targetName),
      request.stagingIdentity,
      'Private staging directory identity changed during publication',
    );
  } else {
    throw new Error('Unknown private directory operation');
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  for (const descriptor of [targetDescriptor, stagingDescriptor]) {
    if (descriptor === undefined) continue;
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
`;

export function publishPrivateDirectoryBackend(
  parentPath: string,
  stagingPath: string,
  targetPath: string,
  parentStat: Stats,
  stagingStat: Stats,
  targetStat: Stats | undefined,
): void {
  const targetName = assertPrivateArtifactImmediateChild(parentPath, targetPath);
  const request = JSON.stringify({
    operation: 'publish-directory',
    stagingName: assertPrivateArtifactImmediateChild(parentPath, stagingPath),
    targetName,
    parentIdentity: serializePrivateArtifactIdentity(parentStat),
    stagingIdentity: serializePrivateArtifactIdentity(stagingStat),
    targetIdentity: targetStat === undefined ? null : serializePrivateArtifactIdentity(targetStat),
  });
  runPrivateArtifactHelper(
    DIRECTORY_OPERATION_SCRIPT,
    request,
    parentPath,
    'Private directory publication failed',
  );
}

export function removePrivateDirectoryBackend(
  parentPath: string,
  stagingPath: string,
  parentStat: Stats,
  stagingStat: Stats,
): void {
  const stagingName = assertPrivateArtifactImmediateChild(parentPath, stagingPath);
  const request = JSON.stringify({
    operation: 'cleanup-directory',
    stagingName,
    quarantineName: `.${stagingName}.${process.pid}.${Date.now().toString(36)}.cleanup`,
    parentIdentity: serializePrivateArtifactIdentity(parentStat),
    stagingIdentity: serializePrivateArtifactIdentity(stagingStat),
  });
  runPrivateArtifactHelper(
    DIRECTORY_OPERATION_SCRIPT,
    request,
    parentPath,
    'Private directory cleanup failed',
  );
}
