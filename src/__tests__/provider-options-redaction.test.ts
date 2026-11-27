import { describe, expect, it } from 'vitest';
import { redactProviderOptions } from '../core/workflow/providerOptionsRedaction.js';

describe('provider option redaction', () => {
  it('redacts auth and passwd query values in DeepSeek Harness plugin sources', () => {
    const options = {
      deepseekHarness: {
        plugins: [
          {
            id: 'private-plugin',
            source: 'git:https://github.com/acme/plugin.git?auth=SECRET_AUTH&passwd=SECRET_PASS',
          },
          {
            id: 'public-plugin',
            source: 'git:https://github.com/acme/plugin.git?note=auth&label=passwd',
          },
        ],
      },
    };

    expect(redactProviderOptions(options)).toEqual({
      deepseekHarness: {
        plugins: [
          {
            id: 'private-plugin',
            source: 'git:https://github.com/acme/plugin.git?auth=[configured]&passwd=[configured]',
          },
          {
            id: 'public-plugin',
            source: 'git:https://github.com/acme/plugin.git?note=auth&label=passwd',
          },
        ],
      },
    });
  });

  it('redacts every plugin config value without mutating runtime options', () => {
    const config = {
      token: 'PLUGIN_TOKEN_SECRET',
      nested: { key: 'NESTED_PLUGIN_SECRET' },
      array: ['ARRAY_PLUGIN_SECRET'],
      enabled: true,
      count: 7,
      empty: null,
    };
    const options = {
      deepseekHarness: {
        plugins: [
          { id: 'configured', source: 'https://example.test/plugin.git', config },
          { id: 'empty', source: 'https://example.test/empty.git', config: {} },
          { id: 'absent', source: 'https://example.test/absent.git' },
        ],
      },
    };
    const redacted = redactProviderOptions(options);
    expect(redacted?.deepseekHarness?.plugins).toEqual([
      {
        id: 'configured',
        source: 'https://example.test/plugin.git',
        config: Object.fromEntries(Object.keys(config).map((key) => [key, '[configured]'])),
      },
      { id: 'empty', source: 'https://example.test/empty.git', config: {} },
      { id: 'absent', source: 'https://example.test/absent.git' },
    ]);
    expect(JSON.stringify(redacted)).not.toContain('PLUGIN_SECRET');
    expect(JSON.stringify(redacted)).not.toContain('PLUGIN_TOKEN_SECRET');
    expect(options.deepseekHarness.plugins[0]?.config).toBe(config);
    expect(config.nested.key).toBe('NESTED_PLUGIN_SECRET');
  });

  it('redacts credentials embedded in Pi extension URLs', () => {
    const originalExtensions = [
      'https://user:secret@example.com/pi-extension.git',
      'https://example.com/pi-extension.git?token=secret&ref=main',
      'https://example.com/pi-extension.git?access_token=access-secret&auth_token=auth-secret&client_secret=client-secret',
      'https://example.com/pi-extension.git?api%5Fkey=encoded-secret',
      'https://example.com/pi-extension.git?token=secret value&ref=main',
      '  https://spaced:secret@example.com/pi-extension.git  ',
      'git+ssh://git@example.com/pi-extension.git',
      'npm:pi-fff',
    ];
    const options = {
      pi: {
        extensions: [...originalExtensions],
      },
    };

    expect(redactProviderOptions(options)).toEqual({
      pi: {
        extensions: [
          'https://[configured]@example.com/pi-extension.git',
          'https://example.com/pi-extension.git?token=[configured]&ref=main',
          'https://example.com/pi-extension.git?access_token=[configured]&auth_token=[configured]&client_secret=[configured]',
          'https://example.com/pi-extension.git?api%5Fkey=[configured]',
          'https://example.com/pi-extension.git?token=[configured]&ref=main',
          'https://[configured]@example.com/pi-extension.git',
          'git+ssh://[configured]@example.com/pi-extension.git',
          'npm:pi-fff',
        ],
      },
    });
    expect(options.pi.extensions).toEqual(originalExtensions);
  });
});
