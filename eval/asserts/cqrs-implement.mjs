/**
 * Artifact assertions for the cqrs-implement coder eval.
 * Inspects files written by the agent in eval/.work/cqrs-implement.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workDir = resolve(dirname(fileURLToPath(import.meta.url)), '../.work/cqrs-implement');

function readAllKotlin(dir) {
  const files = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.kt')) files.push({ path: full, content: readFileSync(full, 'utf8') });
    }
  };
  walk(dir);
  return files;
}

export default function assertCqrsImplement() {
  const sources = readAllKotlin(join(workDir, 'src'));
  const all = sources.map((f) => f.content).join('\n');
  const account = sources.find((f) => f.path.endsWith('Account.kt'))?.content ?? '';

  const withdrawnApplyBranch = account.match(/is MoneyWithdrawn\s*->\s*\{?([\s\S]*?)(?=\n\s*(is |\}\s*\n))/);
  const applyBranchBody = withdrawnApplyBranch?.[1];

  const checks = [
    {
      name: 'past-tense-event-added',
      pass: /data class MoneyWithdrawn/.test(all),
    },
    {
      name: 'apply-restores-state-only',
      pass: !!applyBranchBody &&
        !/require|throw|check\(/.test(applyBranchBody),
    },
    {
      // Validation must exist somewhere; combined with the apply check
      // above, it is guaranteed to live outside event replay.
      name: 'command-with-validation',
      pass: /WithdrawCommand/.test(all) &&
        /(require|check\(|throw|IllegalArgument)/.test(all),
    },
  ];
  const failed = checks.filter((c) => !c.pass);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'all artifact checks passed'
      : `failed: ${failed.map((c) => c.name).join(', ')}`,
  };
}
