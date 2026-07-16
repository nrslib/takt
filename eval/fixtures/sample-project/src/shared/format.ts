import type { User } from '../user-store.js';
import { writeRawFile } from '../infra/file-writer.js';

export function formatUserLabel(user: User): string {
  return user.email ? `${user.name} <${user.email}>` : user.name;
}

export function parseCsvLine(line: string): string[] {
  return line.split(',').map((cell) => cell.trim());
}

export function writeUserCsv(path: string, users: User[]): void {
  const lines = users.map((u) => [u.id, u.name, u.email ?? ''].join(','));
  writeRawFile(path, lines.join('\n'));
}
