import type { Stats } from 'node:fs';
import {
  assertPrivateArtifactImmediateChild,
  runPrivateArtifactHelper,
  serializePrivateArtifactIdentity,
  type SerializedPrivateArtifactIdentity,
} from './private-artifact-helper.js';

const ARTIFACT_CREATOR_SCRIPT = String.raw`
const fs = require('node:fs');
const request = JSON.parse(process.argv[1]);

function assertIdentity(stat, identity, kind, message) {
  const expectedKind = kind === 'directory' ? stat.isDirectory() : stat.isFile();
  if (!expectedKind || String(stat.dev) !== identity.dev || String(stat.ino) !== identity.ino) {
    throw new Error(message);
  }
}

try {
  const parentIdentity = { dev: request.parentDev, ino: request.parentIno };
  assertIdentity(
    fs.statSync('.'),
    parentIdentity,
    'directory',
    'Private artifact parent directory identity changed before creation',
  );
  let created;
  if (request.kind === 'directory') {
    fs.mkdirSync(request.name, { mode: request.mode });
    created = fs.lstatSync(request.name);
  } else if (request.kind === 'file') {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const descriptor = fs.openSync(
      request.name,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      request.mode | 0o200,
    );
    try {
      created = fs.fstatSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } else {
    throw new Error('Unknown private artifact kind');
  }
  assertIdentity(created, { dev: String(created.dev), ino: String(created.ino) }, request.kind, 'unreachable');
  process.stdout.write(JSON.stringify({ dev: String(created.dev), ino: String(created.ino) }));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

const ARTIFACT_PUBLICATION_SCRIPT = String.raw`
const fs = require('node:fs');
const request = JSON.parse(process.argv[1]);

function assertIdentity(stat, identity, kind, message) {
  const expectedKind = kind === 'directory' ? stat.isDirectory() : stat.isFile();
  if (!expectedKind || String(stat.dev) !== identity.dev || String(stat.ino) !== identity.ino) {
    throw new Error(message);
  }
}

function openFile(name, flags, identity, message) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = fs.openSync(name, flags | noFollow);
    assertIdentity(fs.fstatSync(descriptor), identity, 'file', message);
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(message + ': ' + detail, { cause: error });
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

function closeDescriptors(descriptors) {
  let firstError;
  for (const descriptor of descriptors.reverse()) {
    if (descriptor === undefined) continue;
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

let temporaryDescriptor;
let targetDescriptor;
let publishedLinkDescriptor;
let published = false;
try {
  assertIdentity(
    fs.statSync('.'),
    request.parentIdentity,
    'directory',
    'Private artifact parent directory identity changed before publication',
  );
  temporaryDescriptor = openFile(
    request.temporaryName,
    fs.constants.O_RDONLY,
    request.temporaryIdentity,
    'Private artifact temporary file identity changed before publication',
  );

  if (request.targetIdentity === null) {
    if (lstatOrUndefined(request.targetName) !== undefined) {
      throw new Error('Private artifact file identity changed before publication');
    }
    fs.linkSync(request.temporaryName, request.targetName);
    try {
      publishedLinkDescriptor = openFile(
        request.targetName,
        fs.constants.O_RDONLY,
        request.temporaryIdentity,
        'Private artifact file identity changed during publication',
      );
    } catch (error) {
      const published = lstatOrUndefined(request.targetName);
      if (published !== undefined
        && String(published.dev) === request.temporaryIdentity.dev
        && String(published.ino) === request.temporaryIdentity.ino) {
        fs.unlinkSync(request.targetName);
      }
      throw error;
    }
    fs.unlinkSync(request.temporaryName);
    published = true;
  } else {
    targetDescriptor = openFile(
      request.targetName,
      fs.constants.O_RDONLY,
      request.targetIdentity,
      'Private artifact file identity changed before publication: ' + request.targetName,
    );
    fs.renameSync(request.temporaryName, request.targetName);
    published = true;
    assertIdentity(
      fs.lstatSync(request.targetName),
      request.temporaryIdentity,
      'file',
      'Private artifact replacement identity changed during publication',
    );
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try {
    closeDescriptors([
      temporaryDescriptor,
      targetDescriptor,
      publishedLinkDescriptor,
    ]);
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    if (!published) process.exitCode = 1;
  }
}
`;

type PrivateArtifactKind = 'directory' | 'file';

export class PrivateArtifactPublicationConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PrivateArtifactPublicationConflictError';
  }
}

function parseArtifactCreationIdentity(output: string): SerializedPrivateArtifactIdentity {
  const parsed: unknown = JSON.parse(output);
  if (
    parsed === null
    || typeof parsed !== 'object'
    || typeof (parsed as Record<string, unknown>).dev !== 'string'
    || typeof (parsed as Record<string, unknown>).ino !== 'string'
  ) {
    throw new Error('Private artifact creator returned an invalid identity');
  }
  return parsed as SerializedPrivateArtifactIdentity;
}

export function createPrivateArtifact(
  parentPath: string,
  targetPath: string,
  parentStat: Stats,
  kind: PrivateArtifactKind,
  mode: number,
): SerializedPrivateArtifactIdentity {
  const name = assertPrivateArtifactImmediateChild(parentPath, targetPath);
  const request = JSON.stringify({
    kind,
    name,
    mode,
    parentDev: String(parentStat.dev),
    parentIno: String(parentStat.ino),
  });
  return parseArtifactCreationIdentity(runPrivateArtifactHelper(
    ARTIFACT_CREATOR_SCRIPT,
    request,
    parentPath,
    `Private artifact ${kind} creation failed`,
  ));
}

export function publishPrivateArtifact(
  parentPath: string,
  temporaryPath: string,
  targetPath: string,
  parentStat: Stats,
  temporaryStat: Stats,
  targetStat: Stats | undefined,
  mode: number,
): void {
  const request = JSON.stringify({
    operation: 'publish',
    temporaryName: assertPrivateArtifactImmediateChild(parentPath, temporaryPath),
    targetName: assertPrivateArtifactImmediateChild(parentPath, targetPath),
    mode,
    parentIdentity: serializePrivateArtifactIdentity(parentStat),
    temporaryIdentity: serializePrivateArtifactIdentity(temporaryStat),
    targetIdentity: targetStat === undefined ? null : serializePrivateArtifactIdentity(targetStat),
  });
  try {
    runPrivateArtifactHelper(ARTIFACT_PUBLICATION_SCRIPT, request, parentPath, 'Private artifact publication failed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('identity changed before publication')) {
      throw new PrivateArtifactPublicationConflictError(message, { cause: error });
    }
    throw error;
  }
}
