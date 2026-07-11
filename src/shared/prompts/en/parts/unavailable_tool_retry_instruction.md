<!--
  template: unavailable_tool_retry_instruction
  role: retry preamble after an unavailable-tool loop stopped the previous attempt
  caller: infra/opencode/unavailable-tool-recovery
-->
Your previous attempt was stopped because it repeatedly called a tool named {{invalidTool}}, which does not exist.
{{#if aliasHint}}
{{aliasHint}}
{{/if}}
Only the following tools are available in this session: {{validTools}}. Do not call any other tool name.

This is a fresh session, but the workspace is NOT fresh: it still contains every change made by the previous attempt. Re-inspect the current workspace state first, continue from the existing changes, and do not blindly repeat commands or edits that may already have been applied. Do not roll anything back.

{{instruction}}
