/** 同じ物理行にあるキーと値が通知の境目で分割されるケース。 */
export interface SplitSecretScenario {
  readonly name: string;
  readonly chunks: readonly string[];
  readonly secretFragments: readonly string[];
}

function pieces(text: string, size: number): string[] {
  return Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));
}

const secret = 'Zq9vK3mWp7';
export const splitSecretScenarios: readonly SplitSecretScenario[] = [
  { name: 'a long Authorization line split across notifications',
    chunks: ['Authorization: Bearer ' + 'Q'.repeat(4200), 'R'.repeat(4300), '\nready\n'], secretFragments: ['QQQQ', 'RRRR'] },
  { name: 'a long URL credential line split across notifications',
    chunks: ['https://alice:' + 'Q'.repeat(4200), 'R'.repeat(4300), '@example.test/path\nready\n'], secretFragments: ['alice', 'QQQQ', 'RRRR'] },
  { name: 'an assignment with a long same-line value', chunks: pieces(`export MODE=prod API_TOKEN=${'q'.repeat(5000)}\n`, 1024), secretFragments: ['qqqq'] },
  { name: 'a value followed by ordinary same-line text', chunks: [`password=${'q'.repeat(4300)} ok ${'z'.repeat(100)}`, '\n'], secretFragments: ['qqqq'] },
  ...[
    ['an option value', `ps: /usr/bin/agent --token ${secret} --verbose`],
    ['a JSON escaped quoted value', `request body {"cmd":"login password=\\"${secret}\\""}`],
    ['an Authorization header', `Authorization: Bearer ${secret}`],
  ].map(([name, line]) => ({ name: `${name} written one character at a time`, chunks: [...`${line}\n`], secretFragments: [secret] })),
];

export function scenarioText(scenario: SplitSecretScenario): string { return scenario.chunks.join(''); }
export function secretFragmentsIn(text: string, scenario: SplitSecretScenario): string[] {
  return scenario.secretFragments.filter((fragment) => text.includes(fragment));
}
