<!--
  template: score_slug_user_prompt
  role: user prompt for task-name-to-slug generation
  vars: taskDescription
  caller: infra/task/summarize
-->
Generate a slug from the task description below.
Output ONLY the slug text.

<task_description>
{{taskDescription}}
</task_description>
