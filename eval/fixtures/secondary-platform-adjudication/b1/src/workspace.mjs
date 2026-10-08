import { createConnection } from 'node:net';
import { saveWorkspaceSecret } from './secret-file.mjs';
import { sessionEndpoint } from './platform-path.mjs';

export function openWorkspace(_name, { platform = process.platform, connect = createConnection } = {}) {
  return connect(sessionEndpoint(platform));
}

export function openWorkspaceWithSecret(name, secret, options) {
  saveWorkspaceSecret(name, secret);
  return openWorkspace(name, options);
}
