import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type ComposeFile = {
  services?: {
    'otel-lgtm'?: {
      ports?: unknown[];
    };
  };
};

describe('observability compose stack', () => {
  it('binds Grafana and OTLP HTTP ports to localhost only', () => {
    const compose = parse(readFileSync(
      join(process.cwd(), 'docker-compose.observability.yml'),
      'utf-8',
    )) as ComposeFile;

    expect(compose.services?.['otel-lgtm']?.ports).toEqual([
      '127.0.0.1:3000:3000',
      '127.0.0.1:4318:4318',
    ]);
  });
});
