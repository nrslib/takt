import { writeSync } from 'node:fs';

export function checkForUpdates(currentVersion: string, latestVersion: string): void {
  writeSync(2, `takt: Update available ${currentVersion} → ${latestVersion} (npm install --global takt)\n`);
}
