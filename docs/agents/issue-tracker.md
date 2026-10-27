# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on **TheAngryPit/birdclaw** (this fork). Use the `gh` CLI from a clone whose `origin` points at that repository.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment --body "..."`
- **Apply / remove labels**: `gh issue edit --add-label "..."` / `--remove-label "..."`
- **Close**: post the explanation with `gh issue comment --body "..."`, then `gh issue close`.

Before the first `gh issue create` in a session, confirm the target with `gh repo view --json nameWithOwner`. File issues only into **TheAngryPit/birdclaw**, not into upstream **steipete/birdclaw**, unless you explicitly intend upstream.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue on this fork.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.
