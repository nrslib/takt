import { gradeVerdicts } from './frontend-gui.mjs';
export default function assertRejected(output) {
  return gradeVerdicts(output, 'REJECT');
}
