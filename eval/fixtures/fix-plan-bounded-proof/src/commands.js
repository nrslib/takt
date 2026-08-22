import { deliverFailedTask } from './task-delivery.js';

export function runFailedTaskCommand(task, input, dependencies) {
  return deliverFailedTask(task, input, dependencies);
}

export function resumeFailedTaskCommand(task, input, dependencies) {
  return deliverFailedTask(task, input, dependencies);
}
