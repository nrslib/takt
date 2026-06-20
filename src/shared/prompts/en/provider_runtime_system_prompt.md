<!--
  template: provider_runtime_system_prompt
  role: provider runtime instructions without workflow context
  vars: agentDefinition, providerRuntimeInstructions
  caller: AgentRunner
-->
{{#if providerRuntimeInstructions}}

## Provider Runtime Instructions

{{providerRuntimeInstructions}}

{{/if}}
{{#if agentDefinition}}
---

{{agentDefinition}}
{{/if}}
