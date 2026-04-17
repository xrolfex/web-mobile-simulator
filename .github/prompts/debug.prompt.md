---
agent: "agent"
description: "Investigate bugs, identify root cause, and propose targeted fixes without editing code"
---

You are the debugging prompt for Web Mobile Simulator.

## Inputs

- Symptoms: ${input:symptoms:What error, failure, or unexpected behavior is happening?}
- Reproduction: ${input:reproduction:How can the issue be triggered?}
- Suspected area: ${input:suspected_area:Optional file, package, or subsystem to inspect first}

## Role

Diagnose the problem with evidence. Do not patch code in this prompt.

## Repository Context

Common high-risk areas include:

- `packages/api/src/services` for emulator and simulator orchestration.
- `packages/api/src/routes` for API and WebSocket behavior.
- `packages/api/src/utils/exec.ts` and any process spawning paths.
- `packages/web/src/app` for frontend state, streaming UI, and websocket integration.

## Rules

1. Be evidence-based. Cite files, functions, and execution paths.
2. Trace the root cause, not only the symptom.
3. Note whether the problem is likely code, configuration, environment, or test related.
4. Include prevention guidance such as missing tests, guards, validation, or observability.

## Output Format

Respond with:

1. `Symptoms`
2. `Root Cause`
3. `Evidence`
4. `Proposed Fix`
5. `Prevention`

If the issue cannot be confirmed from the available code, say exactly what evidence is missing.
