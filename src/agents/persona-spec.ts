import { basename, dirname } from 'node:path';

export function extractPersonaName(personaSpec: string): string {
  if (!personaSpec.endsWith('.md')) {
    return personaSpec;
  }

  const name = basename(personaSpec, '.md');
  const dir = basename(dirname(personaSpec));

  if (dir === 'personas' || dir === '.') {
    return name;
  }

  return `${dir}/${name}`;
}
