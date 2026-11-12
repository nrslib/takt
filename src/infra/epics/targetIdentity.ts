import { isDeepStrictEqual } from 'node:util';
import type { EpicMember, EpicTarget } from './schema.js';

export function memberKey(member: EpicMember): string {
  return JSON.stringify([member.repositoryDirectory, member.goalId]);
}

export function normalizeTargets(targets: readonly EpicTarget[]): EpicTarget[] {
  const normalized = targets.map((target) => ({ ...target })).sort((left, right) => memberKey(left).localeCompare(memberKey(right)));
  if (new Set(normalized.map(memberKey)).size !== normalized.length) throw new Error('Duplicate Epic target');
  return normalized;
}

export function sameTargets(left: readonly EpicTarget[], right: readonly EpicTarget[]): boolean {
  return isDeepStrictEqual(normalizeTargets(left), normalizeTargets(right));
}
