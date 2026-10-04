# Design Philosophy

[日本語](./design-philosophy.ja.md)

TAKT is built around a simple idea: AI agents should be guided by reusable structure, not trusted to remember everything from prompts.

This document explains the principles behind TAKT's design. It is meant to help users understand why TAKT works the way it does, and to help contributors make consistent decisions as the project evolves.

## Agents Are Powerful, but Not Authoritative

AI agents can plan, implement, review, and summarize work, but their output is probabilistic and context-dependent. TAKT does not treat an agent's answer as authoritative just because it is plausible.

Instead, TAKT puts agents inside a process that defines roles, permissions, expected outputs, review paths, and escalation points.

## Structure Over Prompting

Prompts are useful, but prompts alone do not enforce behavior. An agent can forget instructions, ignore constraints, or drift as context grows.

TAKT uses workflow definitions, steps, rules, output contracts, and quality gates to make the process explicit. The important parts of the process should be represented as structure, not only as text the agent is expected to remember.

## Separation Improves Quality

TAKT separates responsibilities, knowledge, and constraints.

An implementation step should not also be responsible for independently reviewing itself. A reviewer should receive the knowledge and policy needed for review, not every piece of context from the full task history. A judge should focus on deciding the next step, not on rewriting the implementation.

This separation keeps context smaller, makes each agent's responsibility clearer, and improves task quality by giving the right information to the right step.

## Feedback Loops Are First-Class

TAKT treats review, fix, re-review, arbitration, and loop monitoring as part of the core process.

AI-generated work should be able to improve through structured feedback, but feedback loops also need boundaries. TAKT workflows can route findings back to fix steps, aggregate multiple review perspectives, ask for human input, or stop when a loop is no longer productive.

## Human Judgment Is an Escalation Path

TAKT is designed to reduce constant human intervention, not remove human judgment.

When the process can continue safely, agents should handle the routine loop. When requirements are unclear, findings conflict, permissions are insufficient, or the workflow cannot make progress, TAKT should return the decision to a human instead of hiding uncertainty.

## Workflows Are Process Assets

A workflow is not just an execution script. It captures a way of working: phases, roles, review criteria, fix paths, and completion rules.

By storing that process as YAML and composing prompts from reusable facets, TAKT lets individuals and teams share, inspect, and improve their development process over time.

## Traceability Matters

AI work should be inspectable after the fact.

TAKT records reports, logs, context, and task state so users can understand what happened, why a step moved forward, and where a decision came from. Traceability is also the basis for improving workflows: without a record of failures and feedback, the process cannot be tuned reliably.

## Practical Automation Over Full Autonomy

TAKT is not designed around the assumption that agents should run without constraints. It is designed to automate the parts of the process that can be made repeatable, while keeping the process observable, reviewable, and interruptible.

The goal is practical automation: reusable structure, clear responsibilities, controlled feedback, and enough traceability for humans to trust and improve the system.
