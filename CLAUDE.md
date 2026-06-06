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

npm run lint                         # next lint — lints the WHOLE repo, CLI included

# Landing page (optional, separate from the product)
npm run site:dev
npm run site:build
```

There is **no test framework** wired up — no `npm test`, no test files. Verify CLI
changes by building and running commands against a scratch dir (`flapjack init` in a
temp folder, then `run`/`approve`/`costs`).

After editing anything in `src/lib` or `src/cli` you **must `npm run build`** before
the change is visible — the CLI runs `dist/`, never the `.ts` sources.

## Architecture (the CLI)

One CLI drives a provider-neutral engine in `src/lib`. Read these files together to
understand the whole; each is small and single-purpose.

- **`orchestrator.ts` — the ReAct loop (`runAgent`).** Builds a prompt from the agent's
  charter + `knowledge/` + recent channel history, then loops up to `settings.maxSteps`.
  **Hard contract:** the model must reply with exactly ONE JSON object —
  `{thought, action, args}` for a tool call or `{action:"finish", summary}` to stop.
  `extractJson` pulls the first balanced JSON object out of the reply (tolerates code
  fences). Two consecutive unparseable replies → give up and treat the raw text as the
  final summary. Running out of steps → one forced plain-text wrap-up.
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
