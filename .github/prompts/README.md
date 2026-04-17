# Copilot Prompt Files

This directory contains GitHub Copilot prompt files converted from the repository's `.opencode/agents` prompts.

## Available Commands

- `/planner`
- `/builder`
- `/tester`
- `/reviewer`
- `/debug`
- `/doc-writer`
- `/architect`
- `/security`
- `/governance`

## Usage

Open Copilot Chat in VS Code and invoke a prompt by slash command, for example `/planner` or `/builder`.

These files keep the original agent names so the workflow is easy to map from the `.opencode` setup.

## Notes

- The original `.opencode/agents` files are left in place.
- The converted prompts remove opencode-only frontmatter such as `mode`, `model`, permissions, and color.
- Stale references to unrelated projects were removed during conversion.
