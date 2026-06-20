import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const requiredSystems = [
  'x86_64-linux',
  'aarch64-linux',
  'x86_64-darwin',
  'aarch64-darwin',
];
const pinnedActionPattern = /^[^@\s]+\/[^@\s]+@[0-9a-f]{40}$/;
const sdkProviderRuntimePathPattern =
  /@anthropic-ai\/claude-agent-sdk-[^/'"\s]+\/claude|@openai\/codex-[^/'"\s]+\/vendor\/[^/'"\s]+\/bin\/codex/;

function readRequiredFile(relativePath: string): string {
  const absolutePath = join(repositoryRoot, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Required file does not exist: ${relativePath}`);
  }
  return readFileSync(absolutePath, 'utf-8');
}

function expectLine(content: string, line: string): void {
  expect(content.split(/\r?\n/)).toContain(line);
}

function hasNpmDependencySource(flake: string): boolean {
  return flake.includes('npmDepsHash = "sha256-') || flake.includes('importNpmLock');
}

function isIgnoredByGit(relativePath: string): boolean {
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', relativePath], {
    cwd: repositoryRoot,
    encoding: 'utf-8',
  });

  if (result.status === 0) {
    return true;
  }

  if (result.status === 1) {
    return false;
  }

  throw new Error(`git check-ignore failed for ${relativePath}: ${result.stderr}`);
}

describe('Nix flake contract', () => {
  it('Given the flake, When packages are defined, Then every supported system builds takt with buildNpmPackage', () => {
    const flake = readRequiredFile('flake.nix');

    for (const system of requiredSystems) {
      expect(flake).toContain(`"${system}"`);
    }

    expect(flake).toContain('buildNpmPackage');
    expect(flake).toContain('packages = forAllSystems');
    expect(flake).toMatch(/default\s*=\s*pkgs\.buildNpmPackage/);
    expect(flake).toContain('pname = "takt"');
    expect(flake).toContain('src = ./.');
    expect(hasNpmDependencySource(flake)).toBe(true);
    expect(flake).toContain('mainProgram = "takt"');
  });

  it('Given package metadata, When the flake is evaluated, Then version and metadata come from package.json', () => {
    const flake = readRequiredFile('flake.nix');
    const packageJson = JSON.parse(readRequiredFile('package.json')) as {
      homepage: string;
      version: string;
    };

    expect(flake).toContain('builtins.fromJSON');
    expect(flake).toContain('builtins.readFile ./package.json');
    expect(flake).toContain('version = packageJson.version');
    expect(flake).toContain('description = packageJson.description');
    expect(flake).toContain('homepage = packageJson.homepage');
    expect(flake).toContain('license = pkgs.lib.licenses.mit');
    expect(flake).not.toContain(`version = "${packageJson.version}"`);
    expect(flake).not.toContain(`homepage = "${packageJson.homepage}"`);
  });

  it('Given runtime requirements, When package and dev shell are defined, Then Node is shared and Bun is development-only', () => {
    const flake = readRequiredFile('flake.nix');

    expect(flake).toContain('nodejs = pkgs.nodejs_22');
    expect(flake).toContain('nodejs = nodejs');
    expect(flake).toContain('devShells = forAllSystems');
    expect(flake).toContain('pkgs.mkShell');
    expect(flake).toContain('nodejs');
    expect(flake).toContain('pkgs.bun');
  });

  it('Given external CLI providers, When the package expression is defined, Then provider CLIs are not added as Nix inputs', () => {
    const flake = readRequiredFile('flake.nix');

    expect(flake).not.toContain('pkgs.git');
    expect(flake).not.toContain('pkgs.gh');
    expect(flake).not.toContain('pkgs.glab');
    expect(flake).not.toContain('cursor');
    expect(flake).not.toContain('tmux');
  });

  it('Given SDK runtime path patterns, When matching package output paths, Then vendored runtimes are detected', () => {
    expect(sdkProviderRuntimePathPattern.test(
      'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    )).toBe(true);
    expect(sdkProviderRuntimePathPattern.test(
      'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'
    )).toBe(true);
    expect(sdkProviderRuntimePathPattern.test('node_modules/@openai/codex/bin/codex.js')).toBe(false);
  });

  it('Given SDK dependencies that ship provider runtimes, When the package is built, Then those runtimes are preserved', () => {
    const flake = readRequiredFile('flake.nix');

    expect(flake).not.toMatch(sdkProviderRuntimePathPattern);
    expect(flake).not.toContain('-delete');
  });

  it('Given the flake lock, When dependencies are resolved, Then nixpkgs is pinned', () => {
    const lock = JSON.parse(readRequiredFile('flake.lock')) as {
      nodes?: Record<string, { locked?: { owner?: string; repo?: string } }>;
      root?: string;
    };

    expect(lock.root).toBe('root');
    expect(lock.nodes?.nixpkgs?.locked?.owner).toBe('NixOS');
    expect(lock.nodes?.nixpkgs?.locked?.repo).toBe('nixpkgs');
  });

  it('Given the Nix workflow, When CI runs, Then it checks the flake, builds the package, and smoke tests the CLI', () => {
    const workflow = YAML.parse(readRequiredFile('.github/workflows/nix.yml')) as {
      jobs?: Record<string, {
        name?: string;
        steps?: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }>;
      }>;
    };
    const jobs = Object.values(workflow.jobs ?? {});
    const steps = jobs.flatMap((job) => job.steps ?? []);
    const runCommands = steps.map((step) => step.run).filter((run): run is string => Boolean(run));
    const uses = steps.map((step) => step.uses).filter((use): use is string => Boolean(use));
    const checkoutStep = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    const externalUses = uses.filter((use) =>
      !use.startsWith('./') && !use.startsWith('docker://')
    );

    expect(jobs.some((job) => job.name === 'Build and test Nix flake')).toBe(true);
    expect(checkoutStep?.uses).toMatch(pinnedActionPattern);
    expect(checkoutStep?.with?.['persist-credentials']).toBe(false);
    expect(externalUses.every((use) => pinnedActionPattern.test(use))).toBe(true);
    expect(uses.some((use) =>
      use.startsWith('DeterminateSystems/nix-installer-action@') && pinnedActionPattern.test(use)
    )).toBe(true);
    expect(runCommands).toContain('nix flake check -L');
    expect(runCommands).toContain('nix build .#default -L');
    expect(runCommands.some((command) =>
      command.includes("claude_runtime=\"$(find result/lib/node_modules/takt/node_modules")
      && command.includes("-path '*/@anthropic-ai/claude-agent-sdk-*/claude'")
      && command.includes("codex_runtime=\"$(find result/lib/node_modules/takt/node_modules")
      && command.includes("-path '*/@openai/codex-*/vendor/*/bin/codex'")
      && command.includes('test -n "$claude_runtime"')
      && command.includes('test -x "$claude_runtime"')
      && command.includes('test -n "$codex_runtime"')
      && command.includes('test -x "$codex_runtime"')
    )).toBe(true);
    expect(runCommands).toContain('NO_UPDATE_NOTIFIER=1 ./result/bin/takt --version');
    expect(runCommands).toContain('NO_UPDATE_NOTIFIER=1 nix run .#default -- --version');
    expect(runCommands.some((command) =>
      command.includes('nix profile install .#default --profile "$RUNNER_TEMP/takt-profile"')
      && command.includes('NO_UPDATE_NOTIFIER=1 "$RUNNER_TEMP/takt-profile/bin/takt" --version')
    )).toBe(true);
  });

  it('Given the Nix workflow, When third-party actions run, Then GitHub token permissions stay read-only', () => {
    const workflow = YAML.parse(readRequiredFile('.github/workflows/nix.yml')) as {
      permissions?: Record<string, string>;
    };

    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('Given local Nix builds, When result symlinks are created, Then git ignores them', () => {
    const gitignore = readRequiredFile('.gitignore');

    expectLine(gitignore, '/result');
    expectLine(gitignore, '/result-*');
    expect(gitignore.split(/\r?\n/)).not.toContain('result');
    expect(gitignore.split(/\r?\n/)).not.toContain('result-*');
    expect(isIgnoredByGit('result')).toBe(true);
    expect(isIgnoredByGit('result-build')).toBe(true);
    expect(isIgnoredByGit('src/infra/claude-headless/result-response.ts')).toBe(false);
  });
});
