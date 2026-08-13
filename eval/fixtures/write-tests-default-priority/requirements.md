# Manual requeue execution requirements

- When a failed authored leaf and a saved checkpoint coexist, manual Requeue selects the failed leaf as the default action and initial cursor.
- Manual Requeue persists the selected leaf as `restartPoint`, clears `resumePoint`, and leaves the task `pending` for the normal runner.
- The normal runner claims that pending task, and its execution resolution starts a fresh execution at the selected leaf.
- An explicit Resume selection remains available as a separate action and preserves the checkpoint; it must not replace the primary Requeue path.
- This contract covers manual Requeue followed by a later normal-runner claim; automatic requeue performed inside the runner is a separate path and is outside this fixture.
