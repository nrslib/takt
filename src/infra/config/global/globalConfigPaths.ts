import { homedir } from 'node:os';
import { join } from 'node:path';

import type { FacetKind } from 'faceted-prompting';

import { REPERTOIRE_DIR_NAME } from '../constants.js';

type FacetType = FacetKind;

export function getGlobalConfigDir(): string {
  return process.env.TAKT_CONFIG_DIR || join(homedir(), '.takt');
}

export function getGlobalPersonasDir(): string {
  return join(getGlobalConfigDir(), 'personas');
}

export function getGlobalLogsDir(): string {
  return join(getGlobalConfigDir(), 'logs');
}

export function getGlobalConfigPath(): string {
  return join(getGlobalConfigDir(), 'config.yaml');
}

export function getGlobalFacetDir(facetType: FacetType): string {
  return join(getGlobalConfigDir(), 'facets', facetType);
}

export function getRepertoireDir(): string {
  return join(getGlobalConfigDir(), REPERTOIRE_DIR_NAME);
}

export function getRepertoirePackageDir(owner: string, repo: string): string {
  return join(getRepertoireDir(), `@${owner}`, repo);
}
