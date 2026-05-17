[日本語](./tutorial.ja.md)

# Tutorial

This tutorial walks through the basic TAKT flow by improving one small project over three phases.

The example project is a **mini expense memo UI**. You will first build a small frontend, then make it more useful, then polish the layout and interaction details. The `default` workflow is the standard workflow and can be relatively heavy because it includes broader review and test-oriented steps, so this first tutorial uses `frontend-mini`.

## Example Project

You will build a small browser-based expense memo.

1. **Phase 1:** Build the smallest UI for entering an amount, category, and note
2. **Phase 2:** Add total amount, category filtering, deletion, and persistence
3. **Phase 3:** Polish mobile layout, empty states, focus states, and visual design

Instead of asking TAKT to do everything at once, you queue one phase, inspect the result, and then instruct the next improvement.

## 1. Start Without GitHub

First, make the target project a Git repository. Skip this if you are already inside an existing repository.

```bash
git init
git add .
git commit -m "initial commit"
```

TAKT works with branches and task workspaces during execution, so starting from a repository with at least one commit is the safer path.

Start TAKT.

```bash
takt
```

Choose `frontend-mini` as the workflow. The exact order may vary by environment, but it is usually under the `Mini` or `Frontend` category.

```text
Select workflow:
    🎼 default (current)
    📁 🚀 Quick Start/
  ❯ 📁 ⚡ Mini/
    📁 🎨 Frontend/
```

Open the category and select `frontend-mini`.

```text
Select workflow:
    default-mini
  ❯ frontend-mini
    backend-mini
    dual-mini
```

If TAKT asks for an interactive mode, choose **assistant** first.

```text
Select interactive mode:
  ❯ assistant
    persona
    quiet
    passthrough
```

## 2. Phase 1: Build the Smallest UI

Describe the first task to TAKT.

```text
> I want to build a mini expense memo UI that runs in the browser.
> For the first phase, it only needs fields for amount, category, and note, plus a list of added entries.
> Keep it simple with index.html, CSS, and JavaScript.
```

TAKT may ask clarifying questions or organize the task. When the scope is clear, use `/go` to create the task instruction.

```text
> /go This is phase 1, so do not add persistence or summaries yet. Keep it to the smallest usable UI.
```

After the task instruction is generated, TAKT shows actions. Choose **Queue as task**.

```text
What would you like to do?
    Execute now
    Create GitHub Issue
  ❯ Queue as task
    Continue conversation
```

`Queue as task` saves the generated instruction under `.takt/tasks/`. `Execute now` is useful for quick experiments, but the normal tutorial flow is to queue the task and run it with `takt run`.

Run the queued task.

```bash
takt run
```

When execution finishes, inspect the result.

```bash
takt list
```

Select the completed task. TAKT shows actions for that task. Start with **View diff**, then use **Try merge** if the result looks worth trying locally.

```text
Completed task actions:
  ❯ View diff
    Instruct
    Try merge
    Merge & cleanup
    Delete
```

`Try merge` brings the task branch changes into your working tree without committing them. You can inspect the UI and diff locally, then commit manually if you are satisfied.

```text
Completed task actions:
    View diff
    Instruct
  ❯ Try merge
    Merge & cleanup
    Delete
```

## 3. Phase 2: Add Useful Behavior

After checking the phase 1 result, queue the next improvement. You can start a new task from `takt`, or use **Instruct** from `takt list` on the completed task.

To build on the previous result, run `takt list`, select the completed task, and choose **Instruct**.

```text
Completed task actions:
    View diff
  ❯ Instruct
    Try merge
    Merge & cleanup
    Delete
```

Instruct mode lets you discuss the next change with the previous diff and execution report in context.

```text
> For phase 2, add total amount, category filtering, and row deletion.
> Save entries to LocalStorage so they are restored after reload.
```

When the instruction is ready, use `/go`.

```text
> /go Add these features to the existing structure instead of rebuilding the UI from scratch.
```

Choose **Queue as task** again.

```text
What would you like to do?
    Execute now
  ❯ Queue as task
    Continue conversation
```

Run and inspect the result.

```bash
takt run
takt list
```

At this stage, use the same loop: **View diff**, then **Try merge** when you want to inspect it locally, or **Instruct** when the result needs another pass.

## 4. Phase 3: Polish the Experience

Finally, polish the UI and interaction details. This is a good fit for **Instruct**, because TAKT can use the current result as context.

```text
> For phase 3, make the UI work well on narrow mobile widths.
> Add a useful empty state, visible focus styles, and clearer category styling.
> Keep it as a practical everyday tool, not a marketing landing page.
```

Use `/go` to finalize the instruction.

```text
> /go
```

Choose **Queue as task**.

```text
What would you like to do?
    Execute now
  ❯ Queue as task
    Continue conversation
```

Run the task.

```bash
takt run
```

Use `takt list` to inspect the result. If you are satisfied, choose **Merge & cleanup**. If you want to inspect the changes in your working tree before deciding, choose **Try merge**.

```text
Completed task actions:
    View diff
    Instruct
    Try merge
  ❯ Merge & cleanup
    Delete
```

The basic loop is:

```text
takt
  -> choose frontend-mini
  -> talk with assistant
  -> /go
  -> Queue as task
takt run
takt list
  -> View diff
  -> Try merge or Merge & cleanup
  -> use Instruct when you want to queue the next phase
```

## 5. Create a GitHub Issue, Then Queue It

When you are working in a GitHub repository, you can ask TAKT to create a GitHub Issue from the conversation and then queue that Issue as a task.

Make sure GitHub CLI is authenticated.

```bash
gh auth status
```

Start TAKT and choose `frontend-mini`.

```bash
takt
```

Discuss the Issue content with TAKT.

```text
> For phase 2 of the mini expense memo UI, I want to add total amount, category filtering, deletion, and LocalStorage persistence.
> Please organize this into a GitHub Issue with acceptance criteria.
```

When the content is ready, use `/go`.

```text
> /go
```

Review the generated task instruction and choose **Create GitHub Issue**.

```text
What would you like to do?
    Execute now
  ❯ Create GitHub Issue
    Queue as task
    Continue conversation
```

After creating the Issue, queue it as a task. If the menu lets you continue, choose **Queue as task**. If you already know the Issue number, use `takt add`.

```bash
takt add #1
```

Then continue with the same local flow.

```bash
takt run
takt list
```

Using GitHub Issues keeps requirements, discussion, and implementation tasks connected, which is especially useful for team development.

## 6. Create an Issue With Codex, Then Hand It to TAKT

If you create a GitHub Issue while talking with Codex or another development assistant outside TAKT, you can still hand the Issue number to TAKT.

Assume Codex created Issue `#1`.

```bash
takt add #1
```

`takt add #1` fetches the GitHub Issue title, body, and comments, then saves them as a pending TAKT task.

Run it.

```bash
takt run
```

Inspect the result.

```bash
takt list
```

This flow lets your usual AI or GitHub discussion handle Issue creation, while TAKT handles implementation, review, and fix loops.

## Next Steps

- [Task Management](./task-management.md): details for `takt add`, `takt run`, and `takt list`
- [CLI Reference](./cli-reference.md): all commands and options
- [Configuration Guide](./configuration.md): provider, model, workflow, and other settings
