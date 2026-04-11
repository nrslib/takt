import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadPieceFromFile } from '../infra/config/loaders/pieceParser.js';

const BASE_MOVEMENTS = `initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: coder
    instruction: "{task}"
`;

describe('Piece YAML interactive opt-in fields', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-opt-in-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('Given YAML without opt-in keys — When loaded — Then skipInteractiveModeSelection is not true (default off)', () => {
    const yaml = `name: plain-piece
description: no opt-in
interactive_mode: assistant
${BASE_MOVEMENTS}
`;
    const path = join(tempDir, 'plain.yaml');
    writeFileSync(path, yaml);

    const piece = loadPieceFromFile(path, tempDir);

    expect(piece.skipInteractiveModeSelection).not.toBe(true);
  });

  it('Given YAML with skip_interactive_mode_selection true — When loaded — Then PieceConfig carries skip and interactive_mode', () => {
    const yaml = `name: opt-in-piece
description: skip mode picker
interactive_mode: quiet
skip_interactive_mode_selection: true
${BASE_MOVEMENTS}
`;
    const path = join(tempDir, 'opt-in.yaml');
    writeFileSync(path, yaml);

    const piece = loadPieceFromFile(path, tempDir);

    expect(piece).toMatchObject({
      name: 'opt-in-piece',
      interactiveMode: 'quiet',
      skipInteractiveModeSelection: true,
    });
  });

  it('Given YAML with legacy run_interactive_without_task — When loaded — Then key is not surfaced on PieceConfig', () => {
    const yaml = `name: legacy-keys
skip_interactive_mode_selection: true
run_interactive_without_task: true
${BASE_MOVEMENTS}
`;
    const path = join(tempDir, 'legacy.yaml');
    writeFileSync(path, yaml);

    const piece = loadPieceFromFile(path, tempDir);

    expect(piece.skipInteractiveModeSelection).toBe(true);
    expect(piece).not.toHaveProperty('runInteractiveWithoutTask');
  });

  it('Given YAML with run_interactive_without_task true but skip_interactive_mode_selection false — When loaded — Then legacy key is stripped and parse succeeds', () => {
    const yaml = `name: legacy-run-without-skip
skip_interactive_mode_selection: false
run_interactive_without_task: true
${BASE_MOVEMENTS}
`;
    const path = join(tempDir, 'legacy-mixed.yaml');
    writeFileSync(path, yaml);

    const piece = loadPieceFromFile(path, tempDir);

    expect(piece.skipInteractiveModeSelection).toBe(false);
    expect(piece).not.toHaveProperty('runInteractiveWithoutTask');
  });

  it('Given project workflow file under .takt/workflows — When loaded — Then skip_interactive_mode_selection resolves', () => {
    const workflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    const yaml = `name: workflow-opt-in
interactive_mode: passthrough
skip_interactive_mode_selection: true
${BASE_MOVEMENTS}
`;
    writeFileSync(join(workflowsDir, 'wf-opt-in.yaml'), yaml);

    const piece = loadPieceFromFile(join(workflowsDir, 'wf-opt-in.yaml'), tempDir);

    expect(piece.name).toBe('workflow-opt-in');
    expect(piece.skipInteractiveModeSelection).toBe(true);
    expect(piece.interactiveMode).toBe('passthrough');
  });
});
