import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('E2E npm scripts: claude-sdk provider entry', () => {
  it('defines test:e2e:provider:claude-sdk and wires it into test:e2e:provider chain', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:e2e:provider:claude-sdk']).toMatch(/TAKT_E2E_PROVIDER=claude-sdk/);
    const chain = pkg.scripts['test:e2e:provider'];
    expect(chain).toContain('test:e2e:provider:claude-sdk');
    expect(chain.indexOf('claude-sdk')).toBeLessThan(chain.indexOf('provider:codex'));
  });
});
