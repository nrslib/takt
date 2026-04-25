import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const changelogPath = join(process.cwd(), 'CHANGELOG.md');
const changelogContent = readFileSync(changelogPath, 'utf8');
const terminologyMigrationLine = changelogContent
  .split('\n')
  .find(
    (line) =>
      line.includes('完全に廃止')
      && line.includes('workflow_config')
      && line.includes('max_steps'),
  );

if (!terminologyMigrationLine) {
  throw new Error(`Failed to locate terminology migration entry in ${changelogPath}`);
}

const terminologyPair = terminologyMigrationLine.match(/`([^`]+)`\s*\/\s*`([^`]+)`/);

if (!terminologyPair) {
  throw new Error(`Failed to parse deprecated base terms from ${changelogPath}`);
}

function trimPathSeparators(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function lowerCaseIncludesDeprecatedTerm(content: string, term: string): boolean {
  return content.toLowerCase().includes(term.toLowerCase());
}

const deprecatedMappings = new Map<string, string>();
for (const match of terminologyMigrationLine.matchAll(/`([^`]+)`\s*→\s*`([^`]+)`/g)) {
  deprecatedMappings.set(match[2], match[1]);
}

export const deprecatedWorkflowTerm = terminologyPair[1];
export const deprecatedStepTerm = terminologyPair[2];
export const deprecatedWorkflowPluralTerm = `${deprecatedWorkflowTerm}s`;
export const deprecatedStepPluralTerm = `${deprecatedStepTerm}s`;

export function getDeprecatedMappedValue(canonicalValue: string): string {
  const deprecatedValue = deprecatedMappings.get(canonicalValue);
  if (!deprecatedValue) {
    throw new Error(`Deprecated mapping not found for ${canonicalValue} in ${changelogPath}`);
  }
  return deprecatedValue;
}

export function getDeprecatedDirName(canonicalPath: string): string {
  return basename(trimPathSeparators(getDeprecatedMappedValue(canonicalPath)));
}

const deprecatedInlineCodeTerms = [
  ...terminologyMigrationLine.matchAll(/`([^`]+)`/g),
].map((match) => match[1]);

const allowedDeprecatedTermContainers = ['start_movement'];

export const deprecatedTerminologyTerms = Array.from(
  new Set([
    deprecatedWorkflowTerm,
    deprecatedStepTerm,
    deprecatedWorkflowPluralTerm,
    deprecatedStepPluralTerm,
    ...Array.from(deprecatedMappings.values()),
    ...deprecatedInlineCodeTerms.filter((term) => {
      const normalized = term.toLowerCase();
      return !normalized.includes('workflow') && !normalized.includes('step');
    }),
  ]),
).sort((left, right) => right.length - left.length);

export function findDeprecatedTerms(content: string): string[] {
  const sanitizedContent = allowedDeprecatedTermContainers.reduce(
    (current, allowedValue) => current.split(allowedValue).join(''),
    content,
  );
  return deprecatedTerminologyTerms.filter((term) => lowerCaseIncludesDeprecatedTerm(sanitizedContent, term));
}
