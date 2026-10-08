{{#if go}}
## Utterance from /go
{{/if}}
{{#if acp}}
## Utterance from ACP
{{/if}}
{{#if retry}}
## Utterance from /retry
{{/if}}
{{#if taskListRevision}}
## Utterance from task-list revision
{{/if}}
{{#if tell}}
## Utterance from /tell
{{/if}}
{{#if requeue}}
## Utterance from /requeue
{{/if}}

Interpret the following utterance as the last user utterance following the supplied conversation, together with its context. For agreement, adopt the immediately preceding proposal; for a correction, rewrite the relevant part; for a supplement, add it to the relevant part. Do not append the utterance as an independent requirement or copy its wording verbatim into the artifact. Produce the artifact in the format specified for this entry point.
Keep the original task when integrating a supplement, and explicitly relate the added requirement to that task. Resolve the scope stated in the utterance in the artifact; do not turn it back into an open question. Leave only genuinely unspecified technical details as open questions.
{{#if requeue}}
For this entry point, use the utterance only to select the target task and restart position. Do not generate an instruction document.
{{/if}}

{{utterance}}
