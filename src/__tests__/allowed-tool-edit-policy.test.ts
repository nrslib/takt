import { describe, expect, it } from 'vitest';
import {
  CLAUDE_EDIT_TOOL_NAMES,
  keepsAllowedToolWithoutEdit,
  splitClaudeAllowedToolSpecs,
} from '../infra/providers/allowed-tool-edit-policy.js';
import {
  resolveAllowedToolsForProvider,
  resolvePartAllowedToolsForProvider,
} from '../core/workflow/engine/engine-provider-options.js';
import { providerDefaultAllowedToolsWithoutEdit } from '../infra/providers/provider-capabilities.js';
import { resolvePiActiveTools } from '../infra/providers/pi-tool-policy.js';

type OverrideBranch = {
  readonly label: string;
  readonly mode: 'readonly' | 'edit' | 'full' | undefined;
  readonly allowedTools: string[] | undefined;
  readonly expectedOverride: string[];
  readonly expectedWithoutOverride: string[];
};

const OVERRIDE_BRANCHES: OverrideBranch[] = [
  {
    label: 'readonly',
    mode: 'readonly',
    allowedTools: undefined,
    expectedOverride: ['read', 'grep', 'find', 'ls'],
    expectedWithoutOverride: ['grep', 'find', 'ls'],
  },
  {
    label: 'edit',
    mode: 'edit',
    allowedTools: undefined,
    expectedOverride: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'],
    expectedWithoutOverride: ['grep', 'find', 'ls', 'edit', 'write', 'bash'],
  },
  {
    label: 'mode-unset allowlist',
    mode: undefined,
    allowedTools: ['read'],
    expectedOverride: ['read'],
    expectedWithoutOverride: [],
  },
  {
    label: 'full-mode read-only allowlist',
    mode: 'full',
    allowedTools: ['read'],
    expectedOverride: ['read'],
    expectedWithoutOverride: [],
  },
];

/** Builds a registry whose `read` entry comes from the given provenance. */
function overrideRegistry(readSourcePath: string, readSource: string) {
  return [
    { name: 'read', source: readSource, sourcePath: readSourcePath },
    { name: 'grep', source: 'builtin' },
    { name: 'find', source: 'builtin' },
    { name: 'ls', source: 'builtin' },
    { name: 'edit', source: 'builtin' },
    { name: 'write', source: 'builtin' },
    { name: 'bash', source: 'sdk' },
  ];
}

describe('allowed-tool-edit-policy', () => {
  it.each(['PowerShell', 'POWERSHELL', ' powershell '])('normalizes the Pi %s alias for the effective permission boundary', (alias) => {
    const builtin = { name: 'powershell', source: 'builtin' };
    const extension = { name: 'powershell', source: 'extension', sourcePath: '/trusted.ts' };

    for (const mode of [undefined, 'full'] as const) {
      expect(resolvePiActiveTools(mode, [alias], [builtin])).toEqual(['powershell']);
    }
    for (const mode of ['readonly', 'edit'] as const) {
      expect(resolvePiActiveTools(mode, [alias], [builtin])).toEqual([]);
    }
    expect(resolvePiActiveTools(undefined, [alias], [builtin, extension], ['/trusted.ts']))
      .toEqual(['powershell']);
  });

  it('activates a builtin override inside the full-mode read-only allowlist', () => {
    const builtin = { name: 'read', source: 'builtin' };
    const extension = { name: 'read', source: 'extension', sourcePath: '/trusted.ts' };

    for (const alias of ['read', 'Read']) {
      expect(resolvePiActiveTools('full', [alias], [builtin])).toEqual(['read']);
      expect(resolvePiActiveTools('full', [alias], [builtin, extension], ['/trusted.ts']))
        .toEqual(['read']);
    }
    expect(resolvePiActiveTools('full', [], [builtin, extension])).toEqual([]);
    expect(resolvePiActiveTools('full', undefined, [extension])).toEqual(['read']);
    expect(resolvePiActiveTools('full', ['read', 'bash'], [extension]))
      .toEqual(['read', 'bash']);
  });

  it('keeps an ordinary allowlist authoritative when Pi permission mode is unset', () => {
    const tools = [
      { name: 'read', source: 'builtin' },
      { name: 'extension_write', source: 'extension', sourcePath: '/trusted.ts' },
    ];
    expect(resolvePiActiveTools(undefined, ['read'], tools, ['/trusted.ts'])).toEqual(['read']);
    expect(resolvePiActiveTools(undefined, ['extension_write'], tools, ['/trusted.ts']))
      .toEqual(['extension_write']);
    for (const mode of ['readonly', 'edit'] as const) {
      expect(resolvePiActiveTools(mode, ['read'], tools, ['/trusted.ts']))
        .toEqual(['read', 'extension_write']);
    }
  });

  it('activates explicit overrides inside an unset-mode allowlist and rejects ambient tools', () => {
    const tools = [
      { name: 'read', source: 'builtin' },
      { name: 'bash', source: 'sdk' },
      { name: 'powershell', source: 'builtin' },
      { name: 'powershell', source: 'extension', sourcePath: '/trusted.ts' },
      { name: 'trusted_extension', source: 'extension', sourcePath: '/trusted.ts' },
      { name: 'ambient_extension', source: 'extension', sourcePath: '/ambient.ts' },
    ];

    expect(resolvePiActiveTools(
      undefined,
      ['read', 'bash', 'powershell', 'trusted_extension', 'ambient_extension'],
      tools,
      ['/trusted.ts'],
    )).toEqual(['read', 'bash', 'powershell', 'trusted_extension']);
    expect(resolvePiActiveTools(
      undefined,
      ['powershell'],
      [{ name: 'powershell', source: 'builtin' }],
    )).toEqual(['powershell']);
  });

  it('should export Claude edit tool names for provider policy checks', () => {
    expect(CLAUDE_EDIT_TOOL_NAMES).toEqual(new Set([
      'edit',
      'write',
      'apply_patch',
      'patch',
    ]));
  });

  it('should keep non-edit tools and remove edit tools from Claude allowed tools', () => {
    expect(keepsAllowedToolWithoutEdit('Read')).toBe(true);
    expect(keepsAllowedToolWithoutEdit(' Apply_Patch ')).toBe(false);
    expect(keepsAllowedToolWithoutEdit('Bash')).toBe(false);
  });

  it('should remove Claude command and edit tool patterns by canonical tool name', () => {
    expect(keepsAllowedToolWithoutEdit('Bash(python3 -m pytest:*)')).toBe(false);
    expect(keepsAllowedToolWithoutEdit(' bash(which python3) ')).toBe(false);
    expect(keepsAllowedToolWithoutEdit('Write(file_path:*)')).toBe(false);
    expect(keepsAllowedToolWithoutEdit('Read(file_path:*)')).toBe(true);
  });

  it('should split Claude allowed tool entries by top-level comma', () => {
    expect(splitClaudeAllowedToolSpecs('Read,Bash(echo a,b), Grep')).toEqual([
      'Read',
      'Bash(echo a,b)',
      'Grep',
    ]);
  });

  it('should treat comma-separated Claude entries with unsafe tools as unsafe', () => {
    expect(keepsAllowedToolWithoutEdit('Read,Bash')).toBe(false);
    expect(keepsAllowedToolWithoutEdit('Read, Bash')).toBe(false);
    expect(keepsAllowedToolWithoutEdit('Read, Bash(echo a,b)')).toBe(false);
  });

  it('should remove Bash from Claude allowed tools for non-edit report steps', () => {
    expect(resolveAllowedToolsForProvider(
      {
        claude: {
          allowedTools: [
            'Read',
            'Bash',
            'Bash(python3 -m pytest:*)',
            ' bash(which python3) ',
            'Edit',
            'Grep',
          ],
        },
      },
      true,
      false,
      'claude',
    )).toEqual(['Read', 'Grep']);
  });

  it('should normalize comma-separated Claude allowed tools before removing command tools', () => {
    expect(resolveAllowedToolsForProvider(
      {
        claude: {
          allowedTools: [
            'Read,Bash',
            'Glob, Bash(which python3)',
            'Grep,Bash(echo a,b)',
          ],
        },
      },
      false,
      false,
      'claude',
    )).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('should remove Bash from Claude allowed tools when edit is false without output contracts', () => {
    expect(resolveAllowedToolsForProvider(
      { claude: { allowedTools: ['Read', 'Bash'] } },
      false,
      false,
      'claude',
    )).toEqual(['Read']);
  });

  it('should remove Bash from OpenCode allowed tools when edit is false without output contracts', () => {
    expect(resolveAllowedToolsForProvider(
      { opencode: { allowedTools: ['read', 'bash', ' Bash ', 'edit', 'grep'] } },
      false,
      false,
      'opencode',
    )).toEqual(['read', 'bash', ' Bash ', 'grep']);
  });

  it('should remove edit tools from Claude team leader part_allowed_tools when part_edit is false', () => {
    expect(resolvePartAllowedToolsForProvider(
      ['Read', 'Bash', 'Bash(python3 -m pytest:*)', 'Edit', 'Write', 'Grep'],
      false,
      'claude',
    )).toEqual(['Read', 'Grep']);
  });

  it('should normalize comma-separated Claude part_allowed_tools before removing command tools', () => {
    expect(resolvePartAllowedToolsForProvider(
      ['Read,Bash', 'Grep, Bash(which python3)'],
      false,
      'claude',
    )).toEqual(['Read', 'Grep']);
  });

  it('should remove edit tools from OpenCode team leader part_allowed_tools when part_edit is false', () => {
    expect(resolvePartAllowedToolsForProvider(
      ['read', 'bash', ' Bash ', 'edit', 'write', 'grep'],
      false,
      'opencode',
    )).toEqual(['read', 'bash', ' Bash ', 'grep']);
  });

  it('should synthesize the Pi read-only ceiling when edit is false without allowed tools', () => {
    expect(resolveAllowedToolsForProvider(
      undefined,
      false,
      false,
      'pi',
    )).toEqual(['read', 'grep', 'find', 'ls']);
  });

  it('should synthesize the Pi read-only ceiling for output-contract steps unless edit is true', () => {
    expect(resolveAllowedToolsForProvider(
      undefined,
      true,
      undefined,
      'pi',
    )).toEqual(['read', 'grep', 'find', 'ls']);
    expect(resolveAllowedToolsForProvider(
      undefined,
      true,
      true,
      'pi',
    )).toBeUndefined();
  });

  it('should use the Pi read-only ceiling for team leader parts without part_allowed_tools', () => {
    const partAllowedTools = resolvePartAllowedToolsForProvider(undefined, false, 'pi');
    const allowedTools = partAllowedTools ?? resolveAllowedToolsForProvider(
      undefined,
      false,
      false,
      'pi',
    );

    expect(allowedTools).toEqual(['read', 'grep', 'find', 'ls']);
  });

  it('should keep only Pi read aliases when edit is false', () => {
    expect(resolvePartAllowedToolsForProvider(
      ['Read', 'Glob', 'Grep', 'Find', 'LS', 'Edit', 'Write', 'Bash', 'trusted_extension_tool'],
      false,
      'pi',
    )).toEqual(['Read', 'Glob', 'Grep', 'Find', 'LS']);
  });

  it('should expose the Pi read-only ceiling through the provider capability seam', () => {
    expect(providerDefaultAllowedToolsWithoutEdit('pi')).toEqual(['read', 'grep', 'find', 'ls']);
    expect(providerDefaultAllowedToolsWithoutEdit('claude')).toBeUndefined();
    expect(providerDefaultAllowedToolsWithoutEdit(undefined)).toBeUndefined();
  });

  it('should preserve an explicit empty Pi allowlist as deny-all', () => {
    expect(resolvePiActiveTools(
      'edit',
      [],
      [
        { name: 'read', source: 'builtin' },
        { name: 'grep', source: 'builtin' },
        { name: 'find', source: 'builtin' },
        { name: 'ls', source: 'builtin' },
        { name: 'edit', source: 'builtin' },
        { name: 'write', source: 'builtin' },
        { name: 'bash', source: 'sdk' },
        { name: 'trusted_extension_tool', source: 'npm:trusted-extension' },
      ],
    )).toEqual([]);
    expect(resolvePiActiveTools(
      'edit',
      [],
      [
        { name: 'read', source: 'extension', sourcePath: '/trusted.ts' },
        { name: 'grep', source: 'builtin' },
        { name: 'bash', source: 'sdk' },
      ],
      ['/trusted.ts'],
    )).toEqual([]);
  });

  it.each(['readonly', 'edit'] as const)('denies all tools for normalized-empty allowlists in %s', (mode) => {
    const tools = [
      ...overrideRegistry('/trusted.ts', 'extension'),
      { name: 'custom_read', source: 'extension', sourcePath: '/trusted.ts' },
    ];
    for (const allowedTools of [[''], ['  '], [' \t\r\n '], [' ', '', '\t']]) {
      expect(resolvePiActiveTools(mode, allowedTools, tools, ['/trusted.ts'])).toEqual([]);
    }
  });

  describe('trusted builtin override', () => {
    it.each(OVERRIDE_BRANCHES)('activates the explicit extension tool inside the $label boundary', (branch) => {
      expect(resolvePiActiveTools(
        branch.mode,
        branch.allowedTools,
        overrideRegistry('/trusted.ts', 'extension'),
        ['/trusted.ts'],
      )).toEqual(branch.expectedOverride);
    });

    it.each(OVERRIDE_BRANCHES)('rejects an ambient extension tool inside the $label boundary', (branch) => {
      expect(resolvePiActiveTools(
        branch.mode,
        branch.allowedTools,
        overrideRegistry('/ambient.ts', 'npm:ambient-extension'),
        [],
      )).toEqual(branch.expectedWithoutOverride);
    });

    it.each(OVERRIDE_BRANCHES)('rejects a mismatched extension provenance inside the $label boundary', (branch) => {
      expect(resolvePiActiveTools(
        branch.mode,
        branch.allowedTools,
        overrideRegistry('/ambient.ts', 'npm:ambient-extension'),
        ['/trusted.ts'],
      )).toEqual(branch.expectedWithoutOverride);
    });

    it.each(OVERRIDE_BRANCHES)('deduplicates a builtin and extension registration inside the $label boundary', (branch) => {
      expect(resolvePiActiveTools(
        branch.mode,
        branch.allowedTools,
        [{ name: 'read', source: 'builtin' }, ...overrideRegistry('/trusted.ts', 'extension')],
        ['/trusted.ts'],
      )).toEqual(branch.expectedOverride);
    });

    it('does not reactivate builtin overrides excluded by a nonempty allowlist', () => {
      const readonlyTools = [
        { name: 'read', source: 'extension', sourcePath: '/trusted.ts' },
        { name: 'grep', source: 'builtin' },
        { name: 'find', source: 'builtin' },
        { name: 'ls', source: 'builtin' },
      ];
      expect(resolvePiActiveTools('readonly', ['grep'], readonlyTools, ['/trusted.ts']))
        .toEqual(['grep']);
      expect(resolvePiActiveTools('readonly', ['Read'], readonlyTools, ['/trusted.ts']))
        .toEqual(['read']);
      expect(resolvePiActiveTools('readonly', ['grep'], readonlyTools, []))
        .toEqual(['grep']);

      const editTools = [
        { name: 'read', source: 'builtin' },
        { name: 'bash', source: 'extension', sourcePath: '/trusted.ts' },
      ];
      expect(resolvePiActiveTools('edit', ['read'], editTools, ['/trusted.ts']))
        .toEqual(['read']);
      expect(resolvePiActiveTools('edit', ['Bash'], editTools, ['/trusted.ts']))
        .toEqual(['bash']);
      expect(resolvePiActiveTools('edit', ['read'], editTools, []))
        .toEqual(['read']);
    });

    it.each(['readonly', 'edit'] as const)(
      'still grants non-builtin extension tools in %s without reviving excluded builtin names',
      (mode) => {
        const tools = [
          ...overrideRegistry('/trusted.ts', 'extension'),
          { name: 'custom_read', source: 'extension', sourcePath: '/trusted.ts' },
        ];
        expect(resolvePiActiveTools(mode, ['Grep'], tools, ['/trusted.ts']))
          .toEqual(['grep', 'custom_read']);
        expect(resolvePiActiveTools(mode, [' ', ' Grep ', ''], tools, ['/trusted.ts']))
          .toEqual(['grep', 'custom_read']);
        expect(resolvePiActiveTools(mode, ['powershell'], tools, ['/trusted.ts']))
          .toEqual(['custom_read']);
        expect(resolvePiActiveTools(mode, [], tools, ['/trusted.ts'])).toEqual([]);
      },
    );
  });

  it('should intersect Pi edit permissions with a read-only allowlist', () => {
    expect(resolvePiActiveTools(
      'edit',
      ['Read', 'Glob', 'Grep', 'Find', 'LS'],
      [
        { name: 'read', source: 'builtin' },
        { name: 'grep', source: 'builtin' },
        { name: 'find', source: 'builtin' },
        { name: 'ls', source: 'builtin' },
        { name: 'edit', source: 'builtin' },
        { name: 'write', source: 'builtin' },
        { name: 'bash', source: 'sdk' },
        { name: 'trusted_extension_tool', source: 'npm:trusted-extension' },
      ],
    )).toEqual(['read', 'find', 'grep', 'ls']);
  });
});
