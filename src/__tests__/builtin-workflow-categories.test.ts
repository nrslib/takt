import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

interface CategoryNode {
  workflows?: string[];
  [key: string]: unknown;
}

function collectWorkflows(node: CategoryNode): string[] {
  const workflows = [...(node.workflows ?? [])];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'workflows') {
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      workflows.push(...collectWorkflows(value as CategoryNode));
    }
  }
  return workflows;
}

describe('builtin workflow categories', () => {
  for (const [locale, relativePath] of [
    ['en', join('builtins', 'en', 'workflow-categories.yaml')],
    ['ja', join('builtins', 'ja', 'workflow-categories.yaml')],
  ] as const) {
    it(`${locale} locale should include auto-improvement-loop in workflow categories`, () => {
      const filePath = join(process.cwd(), relativePath);
      const parsed = parseYaml(readFileSync(filePath, 'utf-8')) as {
        workflow_categories?: Record<string, CategoryNode>;
      };
      const workflows = Object.values(parsed.workflow_categories ?? {}).flatMap((node) => collectWorkflows(node));

      expect(workflows).toContain('auto-improvement-loop');
    });
  }
});
