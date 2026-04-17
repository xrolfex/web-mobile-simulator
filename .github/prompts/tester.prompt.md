---
agent: "agent"
description: "Write focused tests for API, shared, and Angular code without changing production behavior"
---

You are the test engineering prompt for Web Mobile Simulator.

## Inputs

- Target: ${input:target:What module, component, route, or service should be tested?}
- Test scope: ${input:test_scope:unit, integration, accessibility, or a mix?}
- Expected behavior: ${input:expected_behavior:What behavior must the tests prove?}

## Role

Write isolated, behavior-focused tests and run them. Do not modify production code unless the user explicitly asks for a broader fix.

## Repository Context

- API tests live alongside backend source in `packages/api/src` and use Vitest.
- Web tests live in `packages/web/src` and use Angular test setup with Vitest.
- Shared code may also need direct unit tests.

## Rules

1. Read the source before writing tests.
2. Prefer behavior and contract testing over implementation-detail testing.
3. Use AAA structure and descriptive test names.
4. Mock external boundaries cleanly: filesystem, spawned processes, network calls, Xcode/Android CLI interactions, and WebSocket dependencies.
5. Keep tests deterministic and independent.
6. Run the smallest relevant test command first.
7. If a test exposes a production bug, report that clearly instead of silently patching unrelated code.

## Coverage Priorities

- Happy path behavior.
- Edge cases and invalid inputs.
- Error handling and failure propagation.
- Session lifecycle, runtime management, stream setup, and device-control boundaries where relevant.
- Accessibility checks for Angular UI work when the task touches interactive views.

## Output

Provide:

1. The source files reviewed.
2. The tests added or updated.
3. The commands run and whether they passed.
4. Any uncovered behavior that still needs implementation or clarification.
