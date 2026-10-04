"""One-time R17 audit: requires historical Git objects and local ignored safe traces.
No model calls; prints only counts and verification results. Run from repository root.
"""
import pathlib
import subprocess

paths = [path for path in subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', '622d627cf', '--', 'eval/results'], text=True).splitlines() if not path.endswith('README.md')]
assert len(paths) == 144
for path in paths:
    assert pathlib.Path(path).read_bytes() == subprocess.check_output(['git', 'show', '622d627cf:' + path]), path
assert not subprocess.check_output(['git', 'diff', '811f3e4', '--name-only', '--', 'builtins', 'src']).strip()
assert not subprocess.check_output(['git', 'diff', '622d627cf', '--name-only', '--', 'eval/cases', 'eval/fixtures']).strip()
print('144/144 original public artifact bytes match; production/cases/fixtures unchanged', flush=True)
source = r'''
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { inspectPhase1Receipts } from './eval/providers/report-phase-handoff-audit-v3.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const stages = [ ['red','eval/.results/report-phase-handoff-v3-20261003/red'], ['green-first','eval/.results/report-phase-handoff-v3-20261003/green'], ['green-final','eval/.results/report-phase-handoff-v3-r2-20261003/green'] ];
let phase1 = 0, npm = 0;
for (const [stage, directory] of stages) {
 const summary = JSON.parse(readFileSync('eval/results/report-phase-handoff-v3/' + stage + '-summary.json'));
 for (const row of summary.rows.filter(row => row.phase1)) {
  const bytes = readFileSync(join(directory,row.sampleId,'phase1.trace.json'));
  assert.equal(digest(bytes), row.phase1.actualTraceHash);
  const trace = JSON.parse(bytes);
  for (const entry of row.phase1.selectedVerification.receipts) {
   assert.equal(digest(JSON.stringify(entry.receipt)), entry.receiptHash);
   assert.ok(trace.commands.some(receipt => JSON.stringify(receipt) === JSON.stringify(entry.receipt)));
  }
  const inspected = inspectPhase1Receipts(trace,resolve('eval/fixtures/report-phase-handoff'));
  assert.equal(inspected.build.length, 1);
  assert.equal(inspected.test.length, 1);
  assert.deepEqual([...new Set(inspected.reads.map(read => read.path))].sort(), ['src/session-label.js','tests/session-label.test.js']);
  npm += inspected.build.length + inspected.test.length;
  phase1++;
 }
}
assert.equal(phase1,18); assert.equal(npm,36);
console.log('18 actual safe trace hashes and receipt hashes unchanged; 18 file-read pairs and 36 npm receipts accepted');
'''
subprocess.run(['node', '--input-type=module', '-'], input=source, text=True, check=True)

import hashlib,json
p=pathlib.Path('eval/results/report-phase-handoff-v3/verification-r12.json')
assert hashlib.sha256(p.read_bytes()).hexdigest()=='74c92abfbd684c848b3b4174d8598fdc272b12e4765a86a466b7c5ff8c133707'
print('Historical verification-r12.json bytes unchanged')

p=pathlib.Path('eval/results/report-phase-handoff-v3/verification-r13.json')
assert hashlib.sha256(p.read_bytes()).hexdigest()=='2e2469a83aed44801a43cd99593ad2fb2a60bd34a692fec7ca53c8f29a383250'
print('Historical verification-r13.json bytes unchanged')

p=pathlib.Path('eval/results/report-phase-handoff-v3/verification-r14.json')
assert hashlib.sha256(p.read_bytes()).hexdigest()=='b3e5e26db32290d467eda8ce356083130b65f176f7ec5ee2dd7030c0910b8d04'
print('Historical verification-r14.json bytes unchanged')

p=pathlib.Path('eval/results/report-phase-handoff-v3/verification-r15.json')
assert hashlib.sha256(p.read_bytes()).hexdigest()=='b895d19534b490a609e57a267f8cb78c0bdd2356701533f531dd0d65ca187e2d'
print('Historical verification-r15.json bytes unchanged')

p=pathlib.Path('eval/results/report-phase-handoff-v3/verification-r16.json')
assert hashlib.sha256(p.read_bytes()).hexdigest()=='31926866f30b9a4487377d73e043fb745c330a954fe6a368253fa313992a0e5d'
print('Historical verification-r16.json bytes unchanged')
