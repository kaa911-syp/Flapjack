import { Logo } from "@/components/Logo";

export const dynamic = "force-static";

// Point these at your repo once you publish.
const REPO_URL = "https://github.com/your-org/flapjack";
const REPO_SLUG = "your-org/flapjack";

const DIFFERENTIATORS = [
  {
    title: "A mixture of models, not one vendor",
    body: "Configure many AI services at once — OpenAI, Anthropic, Gemini, Groq, OpenRouter, or a local Ollama — and assign a different one to each agent. Cheap local models on routine work, frontier models on the hard calls. No lock-in.",
  },
  {
    title: "Costs you can actually see",
    body: "Because it runs on your keys, flapjack costs shows exactly what every agent and model spent — tokens and dollars, broken down per agent. Nothing hidden, nothing marked up.",
  },
  {
    title: "Lives in your terminal and your chat",
    body: "Drive the whole org from one clean CLI, then run flapjack serve to take a /flapjack command in Slack and Discord. No dashboard to babysit.",
  },
];

const FEATURES = [
  {
    title: "Agents are markdown",
    body: "Every role, tool, and autonomy level is a .md file you own and version in Git.",
  },
  {
    title: "Human-in-the-loop",
    body: "Anything that touches the real world — sending, paying, deploying — waits for flapjack approve.",
  },
  {
    title: "Full audit trail",
    body: "Every run, model call, tool call, and decision is logged to a local file you can replay.",
  },
  {
    title: "Self-hosted by design",
    body: "One npm install. Data lives in a local file. No SaaS, no telemetry, MIT licensed.",
  },
];

const PROVIDERS = ["OpenAI", "Anthropic", "Google Gemini", "Groq", "OpenRouter", "Together", "Ollama", "LM Studio"];

const COMMANDS: [string, string][] = [
  ["flapjack init", "Scaffold agents/ + knowledge/ in this folder"],
  ['flapjack run <agent> "task"', "Run one agent on a one-off task"],
  ["flapjack run-all", "Put the whole org to work"],
  ["flapjack approvals", "See actions awaiting your approval"],
  ["flapjack costs", "Token + dollar spend, by agent and model"],
  ["flapjack serve", "Host the Slack / Discord /flapjack command"],
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-ink-900 text-slate-200">
      {/* Nav */}
      <header className="sticky top-0 z-10 border-b border-ink-600/70 bg-ink-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="flex items-center gap-2.5">
            <Logo size={30} />
            <span className="text-lg font-extrabold tracking-tight text-white">Flapjack</span>
          </span>
          <nav className="flex items-center gap-2">
            <a href="#install" className="hidden rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-white sm:block">
              Install
            </a>
            <a href="#commands" className="hidden rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-white sm:block">
              Commands
            </a>
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className="btn-primary">
              GitHub
            </a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pb-12 pt-20 text-center">
        <span className="badge mb-5 border border-ink-600 bg-ink-800 text-slate-300">
          Open source · CLI-first · Bring your own key
        </span>
        <h1 className="mx-auto max-w-3xl text-4xl font-extrabold leading-tight tracking-tight text-white sm:text-6xl">
          An AI agent org that runs on a <span className="text-syrup-400">mixture of models</span>,
          from your terminal.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-400">
          Flapjack is an open-source stack of autonomous agents — organized like a company — that
          read, write, and act through your tools. One CLI, your own keys, every agent defined in a
          markdown file you control. No dashboard, no SaaS.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a href="#install" className="btn-primary px-5 py-2.5 text-base">
            Get started
          </a>
          <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className="btn-ghost px-5 py-2.5 text-base">
            Star on GitHub
          </a>
        </div>

        {/* Terminal */}
        <div
          id="install"
          className="mx-auto mt-12 max-w-2xl scroll-mt-24 overflow-hidden rounded-xl border border-ink-600 bg-ink-800 text-left"
        >
          <div className="flex items-center gap-1.5 border-b border-ink-600 px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
            <span className="ml-2 text-xs text-slate-500">install in under a minute</span>
          </div>
          <pre className="overflow-x-auto px-4 py-4 font-mono text-sm leading-relaxed text-slate-300">
            <span className="text-slate-500"># install the CLI</span>
            {"\n"}npm install -g github:{REPO_SLUG}
            {"\n\n"}
            <span className="text-slate-500"># scaffold, connect your own model, go</span>
            {"\n"}flapjack init
            {"\n"}flapjack profile add --provider openai --model gpt-4o-mini --key{" "}
            <span className="text-syrup-400">sk-...</span>
            {"\n"}flapjack run-all
          </pre>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Prefer local &amp; free? Point a profile at Ollama:{" "}
          <code className="text-slate-400">--provider openai-compatible --base-url http://localhost:11434/v1</code>
        </p>
      </section>

      {/* Differentiators */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-center text-sm font-semibold uppercase tracking-widest text-syrup-400">
          What makes it different
        </h2>
        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {DIFFERENTIATORS.map((d, i) => (
            <div key={d.title} className="card p-6">
              <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-syrup-500/15 font-bold text-syrup-400">
                {i + 1}
              </div>
              <h3 className="mb-2 font-semibold text-white">{d.title}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{d.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Feature grid */}
      <section className="mx-auto max-w-6xl px-6 py-8">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="card p-5">
              <h3 className="mb-1.5 font-semibold text-white">{f.title}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Commands */}
      <section id="commands" className="mx-auto max-w-3xl scroll-mt-20 px-6 py-16">
        <h2 className="text-center text-sm font-semibold uppercase tracking-widest text-syrup-400">
          One CLI for the whole org
        </h2>
        <div className="mt-8 overflow-hidden rounded-xl border border-ink-600 bg-ink-800">
          {COMMANDS.map(([cmd, desc], i) => (
            <div
              key={cmd}
              className={`flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between ${
                i > 0 ? "border-t border-ink-600" : ""
              }`}
            >
              <code className="font-mono text-sm text-syrup-400">{cmd}</code>
              <span className="text-sm text-slate-400">{desc}</span>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-3xl px-6 py-16">
        <h2 className="text-center text-sm font-semibold uppercase tracking-widest text-syrup-400">
          How it works
        </h2>
        <div className="mt-8 overflow-x-auto rounded-xl border border-ink-600 bg-ink-800 p-6">
          <pre className="font-mono text-xs leading-relaxed text-slate-400 sm:text-sm">{`flapjack run ─▶ Orchestrator ─▶ model (your key, per-agent)
                     │  ▲
                     ▼  │ JSON action
                   Tools ──gated?──▶ Approvals ──flapjack approve──▶ effect
                     │
                     ▼
       Audit + Cost meter   (local .data/store.json)
                     │
                     ▼
            flapjack serve ─▶ Slack / Discord`}</pre>
        </div>
      </section>

      {/* Providers */}
      <section className="mx-auto max-w-4xl px-6 pb-20 text-center">
        <p className="text-sm text-slate-500">Bring your own key from any of these — or run fully local</p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          {PROVIDERS.map((p) => (
            <span key={p} className="badge border border-ink-600 bg-ink-800 px-3 py-1.5 text-slate-300">
              {p}
            </span>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-ink-600 bg-ink-800/40">
        <div className="mx-auto max-w-3xl px-6 py-16 text-center">
          <h2 className="text-3xl font-bold text-white">Spin up your agent org</h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-400">
            No sign-up, no credit card, no vendor. Just your keys and a markdown file per agent.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <a href="#install" className="btn-primary px-5 py-2.5 text-base">
              Install the CLI
            </a>
            <a href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer noopener" className="btn-ghost px-5 py-2.5 text-base">
              Read the docs
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-ink-600">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 text-sm text-slate-500 sm:flex-row">
          <span className="flex items-center gap-2">
            <Logo size={20} /> Flapjack — MIT licensed. Not affiliated with Pancake.
          </span>
          <span>Built to be self-hosted.</span>
        </div>
      </footer>
    </div>
  );
}
