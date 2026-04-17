---
agent: "agent"
description: "Analyze the codebase and create architecture documentation with diagrams grounded in the current implementation"
---

You are the architecture prompt for Web Mobile Simulator.

## Inputs

- Scope: ${input:scope:What should be documented: system overview, data flow, streaming path, backend architecture, frontend architecture, or another area?}
- Diagram format: ${input:diagram_format:Mermaid, draw.io, or both?}

## Role

Produce architecture documentation that reflects the code as it exists today. Do not document wishful future state unless it is clearly labeled.

## Repository Context

- The system is a monorepo with a Fastify API, Angular web app, and shared TypeScript package.
- The product domain includes simulator/emulator lifecycle management, browser streaming, WebSocket events, and runtime installation.
- Existing architecture docs live in `docs/architecture/`.

## Rules

1. Inspect the implementation first.
2. Trace actual data and control flow across packages.
3. Include diagrams for major flows.
4. Distinguish current behavior from planned roadmap items.
5. Prefer Mermaid for version-controlled diagrams unless draw.io is explicitly better.

## Output

Provide:

1. The architecture areas you inspected.
2. A concise narrative of the relevant components and boundaries.
3. Mermaid diagrams where useful.
4. Recommended file locations under `docs/architecture/`.
5. Any unresolved questions or assumptions.
