import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { parse } from 'yaml';

export default function inputRequestCases() {
  const cases = parse(readFileSync(new URL('./cases/development-loop-input-boundaries.yaml', import.meta.url), 'utf8'));
  return cases.filter(sample => sample.interactive && sample.expected.requires_user_input === true)
    .map(sample => ({
      description: sample.id,
      vars: {
        workflow: sample.workflow,
        interactive: sample.interactive,
        report: sample.report,
        expected_transition: sample.expected,
      },
    }));
}
