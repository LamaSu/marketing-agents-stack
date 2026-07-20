# Build conventions (every package obeys these)

The contract all implementers build to. Read this before writing any package.

## Package shape
- Scope: **`@mstack/<name>`** (e.g. `@mstack/core`, `@mstack/memory`). Apps: `@mstack/portal`, `@mstack/console`, `@mstack/cli` (bin `mstack`).
- Each package has: `package.json`, `tsconfig.json`, `src/`, `src/*.test.ts` (vitest), and a one-paragraph `README.md`.
- `package.json` essentials:
  ```json
  {
    "name": "@mstack/<name>",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
    "scripts": {
      "build": "tsc -p tsconfig.json",
      "typecheck": "tsc -p tsconfig.json --noEmit",
      "test": "vitest run",
      "clean": "rimraf dist"
    }
  }
  ```
- Workspace deps use `"workspace:*"` (e.g. `"@mstack/core": "workspace:*"`).
- `tsconfig.json` extends the root base:
  ```json
  { "extends": "../../tsconfig.base.json",
    "compilerOptions": { "outDir": "dist", "rootDir": "src" },
    "include": ["src/**/*"] }
  ```

## TypeScript rules (tsconfig.base is strict + `verbatimModuleSyntax`)
- **ESM only.** Relative imports MUST carry the `.js` extension (`import { x } from "./schemas.js"`), because `moduleResolution: NodeNext`.
- **`verbatimModuleSyntax` is on** → import types with `import type { X }` and values normally. `zod` is a value import: `import { z } from "zod"`.
- `noUncheckedIndexedAccess` is on → guard array/record access.
- Prefer `z.infer<typeof Schema>` for types; export the schema (value) AND the type.

## Do NOT run `pnpm install` / `pnpm build` locally
The dev tablet has ~700MB free and OOMs on installs of the native deps (duckdb, lancedb, onnxruntime). **Write correct code + tests; do not install or run the build locally.** A consolidated `pnpm install && pnpm -r build && pnpm -r test` runs on the Spark box (aarch64, 111GB RAM) after each wave; failures come back as fix tasks. You may reason about types by reading `@mstack/core` source directly.

## The three mechanical guardrails (never violate)
1. **Reviewer ≠ generator.** No type in `@mstack/reviewer` output carries generated marketing prose. `Finding.recommendedChange` is a short instruction, never a drafted paragraph.
2. **Draft-first / human-approves-every-send.** No adapter or channel exposes a direct-send method. The ONLY path from `Draft` to `dispatched` is `runtime/dispatch.ts`, which refuses any draft lacking a matching `approved` `Approval` row.
3. **Compounding memory.** Every workflow writes to `@mstack/memory` ≥ twice (raw in, decision/outcome out). Nothing is ephemeral.

## Prompt hygiene for product agents
Agent `system` prompts are **job-as-function** ("You produce X"), never identity inflation ("You are an elite Y"). No panic/ALL-CAPS framing. (Calm baseline measurably lowers misaligned output — it matters most in the compliance reviewer.)

## Model ids (product agents; verify live before ship)
`claude-opus-4-8` (reviewer judge), `claude-sonnet-5` (SDR-researcher/copywriter/guideline-author), `claude-haiku-4-5-20251001` (router/classify/score-assist). Centralized in `@mstack/core` `models.ts`.

## Source of truth
`research/06-architecture.md` is the full build spec (schemas, agent contracts, workflows, waves). This file is the how; that file is the what.
