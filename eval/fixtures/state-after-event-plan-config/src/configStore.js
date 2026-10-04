import { readFileSync, writeFileSync } from 'node:fs';

export function saveSettings(filePath, settings) {
  writeFileSync(filePath, JSON.stringify({ rateLimit: settings.rateLimit }));
}

export function loadSettings(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}
