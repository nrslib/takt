# Failed task contract

A persisted source-run identity is authoritative. If it is absent, resolution
searches the complete history for the newest exact task-text match; the recent
run list is only a UI projection. If resolution finds no source run, no report,
order, or source identity from another task may be substituted.

Task records can reach either failed-task command without branch metadata.
Pull-request side effects are skipped unless task branch identity and the
non-detached worktree branch are both available and equal.

Each locale configured by the prompt asset registry must carry failed evidence
as literal data through the provider boundary.
