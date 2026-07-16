<!--
  template: structured_json_schema_instruction
  role: structured output fallback for providers without native schema support
  caller: core/workflow/engine/StepExecutor
-->
{{instruction}}

Return exactly one fenced JSON block that matches this JSON schema:

```json
{{schemaJson}}
```

Do not include any text before or after the JSON block.
