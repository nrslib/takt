import { assertInteractiveTopicBoundary } from './interactive-topic-boundary.mjs';

export default function assertPreviousTopic(output, context) {
  return assertInteractiveTopicBoundary(output, context, 'previous-topic');
}
