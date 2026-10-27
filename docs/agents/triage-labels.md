# Triage labels

The **`/triage`** skill uses five canonical roles. This table maps each role to the label string on **TheAngryPit/birdclaw** issues.

| Role in mattpocock/skills | Label on this repo | Meaning |
| ------------------------- | ------------------ | ---------------------------------------- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

Create missing labels with `gh label create <name> --repo TheAngryPit/birdclaw` when you have permission.
