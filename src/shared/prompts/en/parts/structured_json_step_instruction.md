<!--
  template: structured_json_step_instruction
  role: prompt-based structured rule selection
  caller: agents/structured-caller/shared
-->
{{baseInstruction}}

Return exactly one fenced JSON block with this shape:

```json
{"step": 1}
```

Do not include any text before or after the JSON block.
