/** 出力の書き込みの境目が秘密値の値の途中に入る書き込み方と、どの出力にも現れてはいけない秘密値の断片。 */
export interface SplitSecretScenario {
  readonly name: string;
  readonly chunks: readonly string[];
  readonly secretFragments: readonly string[];
}

function pieces(text: string, size: number): string[] {
  return Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));
}

function fragments(secret: string, length: number): string[] {
  return Array.from({ length: secret.length - length + 1 }, (_, index) => secret.slice(index, index + length));
}

// 末尾 256 文字だけを保留していた確定の仕方では、値より後ろにこれだけの長さがあると値の途中で出力が切れる。
const padding = 'x'.repeat(300);
const unquotedSecret = 'Zq9vK3mWp7';

export const splitSecretScenarios: readonly SplitSecretScenario[] = [
  {
    name: 'a quoted value whose closing quote arrives on a line without a newline',
    chunks: ['API_TOKEN="part1-secret\n', 'part2-secret\n', 'part3-secret"', '\nready\n'],
    secretFragments: ['part1-secret', 'part2-secret', 'part3-secret'],
  },
  {
    name: 'a key whose value starts on the next line after a closed multi-line quoted value',
    chunks: ['API_TOKEN="part1-secret\n', 'part2-secret" password=\n', 'next-secret\n'],
    secretFragments: ['part1-secret', 'part2-secret', 'next-secret'],
  },
  {
    name: 'a credential after another assignment on the same line, written 4096 characters at a time',
    chunks: pieces(`export MODE=prod API_TOKEN=${'q'.repeat(5000)}\n`, 4096),
    secretFragments: ['qqqq'],
  },
  {
    name: 'a credential whose line continues past the value before the newline arrives',
    chunks: [`password=${'q'.repeat(4300)} ok ${'z'.repeat(100)}`, '\n'],
    secretFragments: ['qqqq'],
  },
  {
    name: 'a value on the line after its sensitive key',
    chunks: ['token:\n', `  ${unquotedSecret}\n`],
    secretFragments: fragments(unquotedSecret, 4),
  },
  ...[
    ['an option value separated by a space', `ps: /usr/bin/agent --token ${unquotedSecret} --verbose`],
    ['a JSON escaped quoted value', `request body {"cmd":"login password=\\"${unquotedSecret}\\""}`],
    ['URL user information', `git clone https://deploy:${unquotedSecret}@example.test/repo.git`],
    ['a curl user option', `curl -u deploy:${unquotedSecret} https://example.test`],
  ].map(([form, line]) => ({
    name: `${form} written one character at a time`,
    chunks: [...`${line} ${padding}\n`],
    secretFragments: fragments(unquotedSecret, 4),
  })),
];

export function scenarioText(scenario: SplitSecretScenario): string {
  return scenario.chunks.join('');
}

/** text に含まれる秘密値の断片。 */
export function secretFragmentsIn(text: string, scenario: SplitSecretScenario): string[] {
  return scenario.secretFragments.filter((fragment) => text.includes(fragment));
}
