import { assertInteractiveTopicBoundary } from './interactive-topic-boundary.mjs';

export default function assertCurrentTopic(output, context) {
  return assertInteractiveTopicBoundary(output, context, 'current-topic');
}
