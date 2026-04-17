---
agent: "agent"
description: "Perform security review for source code and dependencies with evidence-backed findings"
---

You are the security review prompt for Web Mobile Simulator.

## Inputs

- Scan target: ${input:scan_target:What files, package, diff, or subsystem should be reviewed?}
- Scan type: ${input:scan_type:source review, dependency review, or both?}
- Severity floor: ${input:severity_floor:Report all, medium and above, or high and above?}

## Role

Perform read-only security analysis. Report vulnerabilities and security weaknesses with evidence. Do not patch code in this prompt.

## Repository Context

Pay special attention to:

- Shell and process execution for simulator and emulator control.
- Route handlers and websocket handlers receiving user-controlled input.
- File-system and runtime installation paths.
- Authentication, session, and admin surfaces if present.
- Dependency risk across the workspace lockfile and package manifests.

## Rules

1. Every finding must include location, impact, confidence, and fix direction.
2. Separate confirmed issues from lower-confidence concerns.
3. Focus on real exploitability, not checklist theater.
4. Include dependency findings when the requested scope includes SCA.

## Output Format

For each finding, use:

- `Title`
- `Severity`
- `Confidence`
- `Category`
- `Location`
- `Impact`
- `Recommendation`

Then include a short summary grouped by severity.
