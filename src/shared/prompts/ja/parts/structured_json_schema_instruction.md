<!--
  template: structured_json_schema_instruction
  role: structured output fallback for providers without native schema support
  caller: core/workflow/engine/StepExecutor
-->
{{instruction}}

次の JSON schema に一致する fenced JSON block をちょうど1つ返してください:

```json
{{schemaJson}}
```

JSON block の前後に余計なテキストを含めないでください。
