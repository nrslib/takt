import { describe, expect, it } from 'vitest';
import { createRoutingWorkFingerprint, normalizeRoutingWorkSnapshot, ROUTING_MODEL_INPUT_VERSION } from '../core/workflow/auto-routing/normalizer.js';
import { buildRoutingWorkSnapshot } from '../core/workflow/auto-routing/snapshot.js';

describe('normalizeRoutingWorkSnapshot', () => {
  it('Given routing work containing credentials and identifiers, When normalizing for an estimator, Then sensitive values are replaced while the work shape remains usable', () => {
    const input = normalizeRoutingWorkSnapshot({
      goal: 'Fix /Users/alice/acme-repo/src/server.ts with token sk-abcdefghijklmnopqrstuvwxyz012345',
      step: {
        name: 'implement',
        tags: ['implementation'],
        instruction: 'Contact alice@example.com and inspect https://example.test/issues/42.',
        stepType: 'normal',
        edit: true,
      },
      remainingWork: [
        {
          source: 'finding',
          description: 'Repository github.com/acme/private-repo has an invalid Authorization: Bearer secret-value.',
        },
      ],
      progress: {
        previousAttemptFailed: false,
        noProgress: false,
        retryingSameWork: false,
      },
    });

    expect(input.version).toBe(ROUTING_MODEL_INPUT_VERSION);
    expect(input.goal).toContain('[PATH]');
    expect(input.goal).toContain('[REDACTED]');
    expect(input.step.instruction).toContain('[EMAIL]');
    expect(input.step.instruction).toContain('[URL]');
    expect(input.remainingWork[0]?.description).toContain('[REPOSITORY]');
    expect(input.remainingWork[0]?.description).toContain('[REDACTED]');
  });

  it('Given long goal, instruction, and remaining-work fields, When normalizing, Then each field keeps its own bounded prefix', () => {
    const goal = `goal:${'g'.repeat(8_000)}`;
    const instruction = `instruction:${'i'.repeat(8_000)}`;
    const remainingWork = `finding:${'w'.repeat(8_000)}`;

    const input = normalizeRoutingWorkSnapshot({
      goal,
      step: {
        name: 'implement',
        tags: [],
        instruction,
        stepType: 'normal',
        edit: true,
      },
      remainingWork: [{ source: 'finding', description: remainingWork }],
      progress: {
        previousAttemptFailed: false,
        noProgress: false,
        retryingSameWork: false,
      },
    });

    expect(input.goal).toContain('goal:');
    expect(input.step.instruction).toContain('instruction:');
    expect(input.remainingWork[0]?.description).toContain('finding:');
    expect(input.goal.length).toBeLessThan(goal.length);
    expect(input.step.instruction.length).toBeLessThan(instruction.length);
    expect(input.remainingWork[0]?.description.length).toBeLessThan(remainingWork.length);
  });

  it('Given slash-separated work terms and absolute paths, When normalizing, Then only the absolute path is replaced', () => {
    const input = normalizeRoutingWorkSnapshot({
      goal: 'Compare input/evidence and normal/parallel before reading /tmp/takt/report.json.',
      step: { name: 'implement', tags: [], stepType: 'normal' },
      remainingWork: [{ source: 'task', description: 'Keep success/failure semantics for /var/tmp/output.log.' }],
      progress: { previousAttemptFailed: false, noProgress: false, retryingSameWork: false },
    });

    expect(input.goal).toContain('input/evidence');
    expect(input.goal).toContain('normal/parallel');
    expect(input.goal).toContain('[PATH]');
    expect(input.remainingWork[0]?.description).toContain('success/failure');
    expect(input.remainingWork[0]?.description).toContain('[PATH]');
  });

  it('Given credentials and finding identifiers in routing text, When normalizing, Then they are redacted before the model input is created', () => {
    const input = normalizeRoutingWorkSnapshot({
      goal: 'Resolve Finding F-0128 with password=example-test-value',
      step: { name: 'implement', tags: [], instruction: 'Conflict C-0007 has token=example-token-value', stepType: 'normal' },
      remainingWork: [{ source: 'finding', description: 'Finding F-0128 conflicts with C-0007.' }],
      progress: { previousAttemptFailed: false, noProgress: false, retryingSameWork: false },
    });
    const serialized = JSON.stringify(input);

    expect(serialized).toContain('[FINDING_ID]');
    expect(serialized).toContain('[CONFLICT_ID]');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toMatch(/F-0128|C-0007|example-test-value|example-token-value/);
  });

  it('Given a secret crossing each remaining-work field budget, When building a snapshot, Then redaction happens before truncation', () => {
    const crossingBoundary = `${'x'.repeat(995)}sk-abcdefghijklmnopqrstuvwxyz012345`;
    const snapshot = buildRoutingWorkSnapshot({
      goal: 'Resolve the private finding',
      userInputs: [],
      step: { name: 'fix', tags: [], stepType: 'normal', passPreviousResponse: false },
      findings: {
        open: [{
          id: 'F-1',
          title: crossingBoundary,
          description: crossingBoundary,
          suggestion: crossingBoundary,
        }],
        conflicts: [],
      },
    });
    const serializedSnapshot = JSON.stringify(snapshot);
    const serializedInput = JSON.stringify(normalizeRoutingWorkSnapshot(snapshot));

    expect(serializedSnapshot).toMatch(/\[(?:REDACTED|SECRET)\]/);
    expect(serializedInput).toMatch(/\[(?:REDACTED|SECRET)\]/);
    expect(serializedSnapshot).not.toContain('sk-');
    expect(serializedInput).not.toContain('sk-');
  });

  it('Given known remote repository identifiers, When normalizing, Then only those slash terms are redacted', () => {
    const snapshot = buildRoutingWorkSnapshot({
      goal: 'Fix nrslib/takt while preserving input/evidence and normal/parallel.',
      userInputs: ['The takt repository needs a focused change.'],
      step: { name: 'fix', tags: [], stepType: 'normal', passPreviousResponse: false },
      findings: { open: [], conflicts: [] },
      sensitiveValues: ['nrslib/takt', 'takt'],
    });
    const input = normalizeRoutingWorkSnapshot(snapshot);
    const serialized = JSON.stringify(input);

    expect(serialized).not.toMatch(/nrslib\/takt|\btakt\b/);
    expect(input.goal).toContain('input/evidence');
    expect(input.goal).toContain('normal/parallel');
    expect(serialized).toContain('[REPOSITORY]');
  });

  it('Given sensitive step metadata, alphanumeric conflict IDs, and platform paths, When normalizing, Then every free-text field is redacted without changing ordinary slash-separated terms', () => {
    const input = normalizeRoutingWorkSnapshot({
      goal: 'Keep input/evidence while fixing src/private/config.ts:42 and lib/service.ts line 82.',
      step: {
        name: 'leader.password=secret-value',
        tags: ['credential=topsecret', 'input/evidence'],
        personaKey: 'token=persona-secret',
        instruction: 'Resolve C-2E12A3C28C63 at C:\\Users\\alice\\private-repo and \\server\\share\\private.txt.',
        stepType: 'agent',
      },
      remainingWork: [{ source: 'finding', description: 'See src/core/router.ts:417.' }],
      progress: { previousAttemptFailed: false, noProgress: false, retryingSameWork: false },
    });
    const serialized = JSON.stringify(input);

    expect(input.step.tags).toContain('input/evidence');
    expect(serialized).toContain('[CONFLICT_ID]');
    expect(serialized).toContain('[PATH]');
    expect(serialized).not.toMatch(/secret-value|topsecret|persona-secret|C-2E12A3C28C63|src\/private\/config\.ts|lib\/service\.ts|router\.ts:417|C:\\Users|server\\share/);
  });

  it('Given file locations and scheme URLs in supported platform forms, When normalizing, Then each location is fully redacted while ordinary slash-separated work terms remain', () => {
    const input = normalizeRoutingWorkSnapshot({
      goal: 'Keep input/evidence and normal/parallel while fixing /secret, /Users/Alice Smith/private repo/secret.ts:L42, C:/Users/Alice Smith/private repo/secret.ts line: 42, C:\\Users\\Alice Smith\\private repo\\secret.ts:L42, and \\\\server name\\Share Name\\private repo\\secret.ts line: 42.',
      step: {
        name: 'fix',
        tags: [],
        instruction: 'Inspect file:///Users/Alice%20Smith/private-repo/secret.ts and ftp://private.example/team/repo.',
        stepType: 'normal',
      },
      remainingWork: [{ source: 'finding', description: 'Do not alter input/evidence or success/failure.' }],
      progress: { previousAttemptFailed: false, noProgress: false, retryingSameWork: false },
    });
    const serialized = JSON.stringify(input);

    expect(input.goal).toContain('input/evidence');
    expect(input.goal).toContain('normal/parallel');
    expect(input.remainingWork[0]?.description).toContain('success/failure');
    expect(serialized).toContain('[URL]');
    expect(serialized).not.toMatch(/\/secret|\/Users|C:\/Users|C:\\Users|server name|Share Name|file:\/\/|ftp:\/\//);
  });

  it('Given basename and directory file locations with line numbers in routing text, When normalizing, Then both goal and remaining work replace paths without replacing version strings', () => {
    const input = normalizeRoutingWorkSnapshot({
      goal: 'Inspect normalizer.ts:42, resolver.ts line 8, src/private/file.ts:9, and lib/private/file.ts line 10; retain v1.2.3 and v1.2.3:4.',
      step: { name: 'fix', tags: [], stepType: 'normal' },
      remainingWork: [{
        source: 'finding',
        description: 'Update normalizer.ts:42, resolver.ts line 8, src/private/file.ts:9, and lib/private/file.ts line 10; retain v1.2.3 and v1.2.3:4.',
      }],
      progress: { previousAttemptFailed: false, noProgress: false, retryingSameWork: false },
    });

    expect(input.goal).toBe('Inspect [PATH], [PATH], [PATH], and [PATH]; retain v1.2.3 and v1.2.3:4.');
    expect(input.remainingWork[0]?.description).toBe('Update [PATH], [PATH], [PATH], and [PATH]; retain v1.2.3 and v1.2.3:4.');
  });

  it('Given a replaced finding identity with otherwise identical work, When fingerprinting, Then it is treated as new local work without exposing the ID to the model', () => {
    const createSnapshot = (id: string) => buildRoutingWorkSnapshot({
      goal: 'Resolve the open validation failure',
      userInputs: [],
      step: { name: 'fix', tags: [], stepType: 'normal', passPreviousResponse: false },
      findings: { open: [{ id, description: 'The same validation failure remains.' }], conflicts: [] },
    });
    const first = createSnapshot('F-1000');
    const replacement = createSnapshot('F-1001');

    expect(createRoutingWorkFingerprint(replacement)).not.toBe(createRoutingWorkFingerprint(first));
    expect(JSON.stringify(normalizeRoutingWorkSnapshot(replacement))).not.toMatch(/F-1001/);
  });

  it('Given more remaining work than the aggregate budget allows, When normalizing, Then a deterministic prefix and only the omitted count are retained', () => {
    const input = normalizeRoutingWorkSnapshot({
      goal: 'Apply focused fixes',
      step: { name: 'fix', tags: [], stepType: 'normal' },
      remainingWork: Array.from({ length: 100 }, (_, index) => ({
        source: 'finding' as const,
        description: `finding-${index}:${'x '.repeat(500)}`,
      })),
      progress: { previousAttemptFailed: false, noProgress: false, retryingSameWork: false },
    });

    expect(input.remainingWork).toHaveLength(7);
    expect(input.remainingWork[0]?.description).toContain('finding-0:');
    expect(input.remainingWorkOmittedCount).toBe(93);
    expect(JSON.stringify(input).length).toBeLessThan(10_000);
  });

  it('Given work that differs only after the model budget, When fingerprinting, Then the local identity changes without retaining either body', () => {
    const prefix = 'x'.repeat(2_000);
    const first = {
      goal: 'Apply focused fixes',
      step: { name: 'fix', tags: [], stepType: 'normal' as const },
      remainingWork: Array.from({ length: 65 }, (_, index) => ({
        source: 'finding' as const,
        description: index === 64 ? `${prefix}tail-a` : `finding-${index}`,
      })),
      progress: { previousAttemptFailed: false, noProgress: false, retryingSameWork: false },
    };
    const replacement = {
      ...first,
      remainingWork: first.remainingWork.map((work, index) => index === 64 ? { ...work, description: `${prefix}tail-b` } : work),
    };

    expect(createRoutingWorkFingerprint(replacement)).not.toBe(createRoutingWorkFingerprint(first));
    expect(JSON.stringify(normalizeRoutingWorkSnapshot(replacement))).not.toContain('tail-b');
  });
});
