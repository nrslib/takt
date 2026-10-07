import { createConnection } from 'node:net';

export function openWorkspace() {
  return createConnection('/tmp/workspace-session.sock');
}
