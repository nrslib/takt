import { describe, expect, it } from 'vitest';
import assertInitialReviewContractDiscovery from '../../eval/asserts/initial-review-contract-discovery.mjs';

const projectionPaths = [
  'src/application.js',
  'src/preview.js',
  'src/doctor.js',
  'src/catalog-row.js',
  'src/list-command.js',
  'src/node-text.js',
  'src/node-record.js',
  'tests/public-projections.test.js',
];
const identityPaths = [
  'src/application.js',
  'src/name-schema.js',
  'src/path-key.js',
  'src/job-store.js',
  'src/checkpoint.js',
  'src/event-bus.js',
  'src/execution-token-a.js',
  'src/execution-token-b.js',
  'src/execution-token-c.js',
  'src/resume-codec.js',
  'src/progress-text.js',
  'src/status-record.js',
];

function tableRow(familyTag: string, location: string, problem: string, repair: string): string {
  return `| ${familyTag} | ${location} | ${problem} | ${repair} |`;
}

function tableOutput(rows: string[], includeFlowEvidence = true): string {
  const output = [
    'Verdict: REJECT',
    '| family_tag | Location | Problem | Fix |',
    '| --- | --- | --- | --- |',
    ...rows,
    'src/summary.js is unchanged after verification.',
    'src/audit-key.js is an adjacent contract and out_of_scope.',
  ];
  if (includeFlowEvidence) {
    output.push(
      'Data-flow evidence: inspectNode in src/application.js calls renderPreview, listNode, printNode, and nodeRecord.',
      'Data-flow evidence: inspectExecution in src/application.js calls JobStore, tokenA, restoreResumeNamespace, and statusRecord.',
    );
  }
  return output.join('\n');
}

const projectionProblem = 'control and worker task behavior is incorrect';
const projectionRepair = 'separate control and worker task handling';
const identityProblem = 'identity collision creates the same key';
const identityRepair = 'encode identity and add collision tests';

describe('initial review contract discovery assertion', () => {
  it('accepts multiple rows with the same normalized family tag', () => {
    const rows = [
      ...projectionPaths.map((path) => tableRow('projection', path, projectionProblem, projectionRepair)),
      ...identityPaths.map((path) => tableRow('identity', path, identityProblem, identityRepair)),
    ];

    expect(assertInitialReviewContractDiscovery(tableOutput(rows)).pass).toBe(true);
  });

  it('rejects one contract family split across different family tags', () => {
    const rows = [
      ...projectionPaths.map((path) => tableRow('projection', path, projectionProblem, projectionRepair)),
      ...identityPaths.map((path, index) => tableRow(`identity-${index}`, path, identityProblem, identityRepair)),
    ];

    expect(assertInitialReviewContractDiscovery(tableOutput(rows)).pass).toBe(false);
  });

  it('rejects a complete path inventory without call-path evidence', () => {
    const rows = [
      ...projectionPaths.map((path) => tableRow('projection', path, projectionProblem, projectionRepair)),
      ...identityPaths.map((path) => tableRow('identity', path, identityProblem, identityRepair)),
    ];

    expect(assertInitialReviewContractDiscovery(tableOutput(rows, false)).pass).toBe(false);
  });

  it('merges table and labeled records by case-insensitive family identity', () => {
    const rows = projectionPaths.map((path) => tableRow('shared', path, projectionProblem, projectionRepair));
    const labeledIdentity = [
      'family_tag: SHARED',
      `Location: ${identityPaths.join(', ')}`,
      `Problem: ${identityProblem}`,
      `Fix: ${identityRepair}`,
    ].join('\n');

    expect(assertInitialReviewContractDiscovery(`${tableOutput(rows)}\n${labeledIdentity}`).pass).toBe(false);
  });

  it('does not treat a Markdown table header as a second family', () => {
    const rows = [
      ...projectionPaths.map((path) => tableRow('shared', path, projectionProblem, projectionRepair)),
      ...identityPaths.map((path) => tableRow('shared', path, identityProblem, identityRepair)),
    ];

    expect(assertInitialReviewContractDiscovery(tableOutput(rows)).pass).toBe(false);
  });

  it('parses a wrapped provider response with labeled location sections', () => {
    const review = [
      'Verdict: REJECT',
      '- `family_tag`: `projection`',
      '- 場所:',
      ...projectionPaths.map((path) => `  - ${path}`),
      `- 問題: ${projectionProblem}`,
      `- 修正方針: ${projectionRepair}`,
      '- `family_tag`: `identity`',
      '- 根本原因:',
      ...identityPaths.slice(0, 2).map((path) => `  - ${path}`),
      '- 影響箇所:',
      ...identityPaths.slice(2).map((path) => `  - ${path}`),
      `- 問題: ${identityProblem}`,
      `- 修正方針: ${identityRepair}`,
      'Data-flow evidence: inspectNode in src/application.js calls renderPreview, listNode, printNode, and nodeRecord.',
      'Data-flow evidence: inspectExecution in src/application.js calls JobStore, tokenA, restoreResumeNamespace, and statusRecord.',
      'src/summary.js is unchanged after verification.',
      'src/audit-key.js is an adjacent contract and out_of_scope.',
    ].join('\n');

    expect(assertInitialReviewContractDiscovery(JSON.stringify({ output: review })).pass).toBe(true);
  });
});
