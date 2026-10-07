import { createConnection } from 'node:net';
import { saveWorkspaceSecret } from './secret-file.mjs';
import { sessionEndpoint } from './platform-path.mjs';

export function openWorkspace(name, secret) {
  saveWorkspaceSecret(name, secret);
  return createConnection(sessionEndpoint());
}
