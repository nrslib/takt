# Accepted manual Requeue contract

When a failed authored leaf and a saved checkpoint coexist, manual Requeue selects the failed leaf as its default action and initial cursor. It persists that leaf as `restartPoint`, clears `resumePoint`, and leaves the task `pending` for the normal runner. The runner claims the task, and its execution resolution starts a fresh execution at the selected leaf. An explicitly selected Resume action remains available and preserves the checkpoint. Automatic requeue performed inside the runner is a separate path and is outside this contract.
