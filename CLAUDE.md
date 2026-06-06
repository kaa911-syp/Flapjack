# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Flapjack is a **CLI** that runs an org of AI agents on your own API keys. Agents are
markdown files; everything persists to a local JSON file. There is no SaaS backend.

The repo holds **two unrelated TypeScript projects** that share a `package.json`:

1. **The CLI — the product.** `src/cli/` + `src/lib/`. Compiled with `tsconfig.cli.json`
   to `dist/` as **CommonJS**. The `flapjack` bin points at `dist/cli/index.js`.
2. **A Next.js marketing landing page — not the product.** `src/app/` + `src/components/`.
   Type-checked by the root `tsconfig.json` (`noEmit`), served by `next`. Editing it
   has no effect on the CLI and vice versa. Don't conflate the two.

## Commands

```bash
# Build the CLI (compiles only src/lib + src/cli → dist/). Also runs on `npm install` (prepare).
npm run build

# Run the CLI in dev: build first, then invoke the compiled output.
npm run flapjack -- <command>        # e.g. npm run flapjack -- list
# or `npm link` once to get a global `flapjack` on PATH.

npm test                             # build the CLI, then run the test/ suite (Node's built-in runner)

npm run lint                         # next lint — lints the WHOLE repo, CLI included

# Landing page (optional, separate from the product)
npm run site:dev
npm run site:build
```

Tests run on **Node's built-in test runner** (`node --test`, zero extra dependencies).
`npm test` builds the CLI first, then runs the suite in `test/` — 13 `.test.mjs` files
(`pricing`, `store-roundtrip`, `store-migrate`, `retry`, `cli`, `fetch-url`, `config-tools`,
`memory`, `delegation-guard`, `delegation-loop`, `native-loop`, `gating`, `serve`) covering
pricing math, the store's round-trip + legacy-settings migration, LLM retry/backoff, CLI
dispatch, the fetch-url and config/memory tools, the delegation guard + loop protection, the
native tool-calling loop, approval gating, and the `serve` HTTP layer. The tests exercise the
compiled `dist/`, so the build always runs first. For ad-hoc checks you can still run the CLI
against a scratch dir (`flapjack init` in a temp folder, then `run`/`approve`/`costs`).

After editing anything in `src/lib` or `src/cli` you **must `npm run build`** before
the change is visible — the CLI runs `dist/`, never the `.ts` sources.

## Architecture (the CLI)

One CLI drives a provider-neutral engine in `src/lib`. Read these files together to
understand the whole; each is small and single-purpose.

- **`orchestrator.ts` — the agent loop (`runAgent`).** Builds a prompt from the agent's
  charter + `knowledge/` + recent channel history, then loops up to `settings.maxSteps`.
  Each step calls `llm.ts`'s `complete()` with the **native tool schemas** the agent is
  allowed to call (`schemasFor(agent.tools)`) and reads `res.toolCalls`. A reply with **no
  tool calls** is the finish — its plain text becomes the final summary. Otherwise every
  requested call is run inline, queued for approval, or delegated, and each result is fed
  back as a `tool`-role message for the next step. On the **final step** it passes
  `toolChoice:"none"`, so tools are withheld and the model is forced to produce a plain-text
  wrap-up — no extra LLM call needed. An opt-in `Profile.toolMode:"json"` fallback (handled
  in `llm.ts`'s `completeJsonMode`, not in the loop) serves local models without native tool
  support: it injects a JSON protocol into the prompt and parses one `{action, args}` object
  back into the same `toolCalls` shape, so the orchestrator loop is identical either way.
- **`tools.ts` — the tool registry.** Each tool is either `gated: false` (runs inline in
  the loop via `run()`) or `gated: true` (a real-world side effect that is **never executed
  in the loop** — it creates a pending `Approval` and returns). Gated effects live in
  `effect()` and ship **simulated**; wiring a real API means implementing `effect()`, and
  the tool stays behind the approval gate. To add a tool: add an entry here and list its id
  in an agent's `tools:` frontmatter.
- **`approvals.ts`.** `approve(id)` is what actually runs a gated tool's `effect()`;
  `reject(id)` runs nothing. Both mirror the outcome to chat and write the audit log.
- **`llm.ts` — the BYOK provider layer.** Single `complete()` reduces openai /
  openai-compatible / anthropic / gemini to "messages in → text + token usage out", so the
  orchestrator never sees provider differences. 90s abort timeout. `openai-compatible`
  permits an empty key (local Ollama/LM Studio). When a provider returns no usage, tokens
  are **estimated** (~4 chars/token) and flagged `estimated` for the cost meter.
- **`agents.ts`.** Loads `agents/*.md` (gray-matter frontmatter) fresh on **every** call —
  no caching, edits take effect immediately. `id` = slug of the filename. Missing/invalid
  `autonomy` defaults to `"approval"`. `knowledge/*.md` are concatenated into every prompt.
- **`db.ts` — the single source of truth (`.data/store.json`).** See its own section below.
- **`connectors.ts` / `inbound.ts`.** Outbound chat mirroring + zero-dependency inbound
  signature verification (Slack HMAC-SHA256 with a 5-min replay window; Discord Ed25519 via
  a hand-built SPKI DER wrapper). `inbound.ts` routes a command: first word may name an
  agent, otherwise it falls back to `chief-of-staff` (or the first agent).
- **`pricing.ts`.** Static per-1M-token price table, longest-substring match on model id.
  Unknown / local models cost $0. It's a transparency aid, not billing.

### Autonomy gating (frontmatter `autonomy:`)

- `suggest` — may **not** call gated tools at all (loop tells it to recommend instead).
- `approval` / `autonomous` — may call gated tools, but they still queue for a human.
  There is currently **no path that auto-executes a gated tool**; `autonomous` and
  `approval` behave the same at the gate.

## State & persistence — read before touching `db.ts` or adding a command

All state is one JSON file at `process.cwd()/.data/store.json`. Consequences:

- **The CLI operates on the directory you run it in**, not where it's installed. `agents/`,
  `knowledge/`, and `.data/` are all resolved from `process.cwd()`.
- **Writes are debounced 50ms.** A short-lived CLI process can exit before the write fires
  and silently lose the mutation. `main()` calls **`flushStore()` before exit** to force it.
  The `serve` command returns early and skips the flush *on purpose* (it's long-running). If
  you add a new command that mutates state, make sure execution reaches the `flushStore()`
  at the end of `main()` — an early `return` will drop data.
- The store is cached on `globalThis` (survives Next.js HMR) and `reloadIfStale()` re-reads
  if another process wrote a newer file — this mitigates `serve` and a one-shot CLI command
  clobbering each other. Writes are atomic (tmp file + rename).
- `migrateSettings` accepts a legacy single-provider settings shape and upgrades it to the
  `profiles[]` array — preserve this when changing the `Settings` type.

### Profiles = mixture-of-models (BYOK)

`settings.profiles[]` holds any number of named provider connections. An agent's
`profile:` frontmatter selects one **by id or name**; `resolveProfile` falls back to the
default profile, then the first. Env vars (`FLAPJACK_*`, see `.env.example`) only **seed**
a profile into a fresh store — the normal config path is the CLI (`flapjack profile add`,
`flapjack connectors set`). Keys live only in `.data/store.json` and are sent only to the
provider you configured.

## Adding a CLI command

Commands are plain functions in `src/cli/index.ts` dispatched from the `switch` in `main()`.
Arg parsing is the local `parseArgs` (positionals in `_`, `--flag value` / `--flag=value` /
`--bool` in `flags`). No command framework. Keep new state mutations going through `db.ts`
helpers so the flush/reload guarantees hold.
