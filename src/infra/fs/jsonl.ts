import { appendFileSync } from 'node:fs';

export function appendJsonLine(filepath: string, record: object): void {
  appendFileSync(filepath, `${JSON.stringify(record)}\n`, 'utf-8');
}
