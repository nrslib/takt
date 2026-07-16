<!--
  template: structured_json_step_instruction
  role: prompt-based structured rule selection
  caller: agents/structured-caller/shared
-->
{{baseInstruction}}

次の形の fenced JSON block をちょうど1つ返してください:

```json
{"step": 1}
```

JSON block の前後に余計なテキストを含めないでください。
