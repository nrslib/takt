<!--
  template: issue_title_user_prompt
  role: user prompt for GitHub issue title generation
  vars: taskDescription
  caller: infra/github/issue
-->
Generate a GitHub issue title from the task description below.
Output ONLY the title text (no explanation, no quotes).

<task_description>
{{taskDescription}}
</task_description>
