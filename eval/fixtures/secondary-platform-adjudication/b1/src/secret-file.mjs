import { writeFileSync } from 'node:fs';

export function saveWorkspaceSecret(name, secret) {
  writeFileSync(`.workspace-${name}.secret`, secret, { mode: 0o600 });
}
