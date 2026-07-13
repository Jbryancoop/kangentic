<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic Logo" width="128" /></a>
</p>

<h1 align="center"><a href="https://www.kangentic.com">Kangentic</a></h1>

<p align="center">
  <strong>Drag a card. An agent starts.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="GitHub release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 License" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen.svg?style=flat-square" alt="Platform" />
  <a href="https://www.kangentic.com"><img src="https://img.shields.io/badge/website-kangentic.com-purple.svg?style=flat-square" alt="Website" /></a>
  <a href="https://github.com/Kangentic/kangentic/stargazers"><img src="https://img.shields.io/github/stars/Kangentic/kangentic?style=social" alt="GitHub Stars" /></a>
</p>

---

<p align="center">A Kanban board for AI coding agents. Spawn, suspend, and resume eleven coding-agent CLIs from one board, with your own backlog. Local, free, open source.</p>

<p align="center">AI coding agents can build features, fix bugs, and refactor entire modules autonomously. With git worktrees you can run many of them in parallel, but now the bottleneck is <strong>you</strong>: juggling terminals across projects to track which agents are stuck, finished, or waiting for approval. Kangentic replaces that with a Kanban command center. One board shows every agent's status, output, and progress. Respond when needed; let them work autonomously the rest of the time.</p>

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/social/og-image.png" alt="Kangentic: Kanban board for AI coding agents" width="800" /></a>
</p>

## Features

- **Backlog, labels & priorities** - stage work in a dedicated backlog before it hits the board. Tag items with custom labels and colors, rank them on a fully-customizable priority scale, and batch-promote a week's worth of work to any column in one move.
- **Customizable workflows** - build pipelines like Plan, Execute, Review. Set permission modes, auto-commands, and transition actions per column. Configure a plan-exit target so cards advance automatically after planning, inject prompts on column entry, and chain scripts or PRs on the way out.
- **Real-time status** - see which agents are thinking or idle right on the card, with per-agent activity detection via native hooks where available and PTY fallbacks where not. Desktop notifications fire when an agent needs your attention.
- **Agent-to-board tools** - agents that self-organize. Every running session has MCP tools to create tasks, move cards, search prior sessions, and queue follow-up work, so a planning agent can hand a backlog to an executing agent without you touching the board.
- **Git worktrees & review** - each agent runs in its own git worktree for parallel development without branch conflicts. When work is ready, the built-in Changes panel opens a split or inline diff viewer with file tree, a commit graph, and a Markdown preview, one click from the task card.
- **Session persistence** - sessions survive restarts and crashes. Orphaned sessions are detected on startup and resumable. Suspend to Done, resume later with full context, nothing is lost.
- **Handoff context** - hand work between agents without losing context. When a card moves from a Claude plan column to a Codex execute column, the next agent starts with the full history of what came before. Supported in both directions for Claude, Codex, Gemini, Qwen, Kimi, and OpenCode.
- **Terminal & activity log** - a built-in terminal for every session, plus a structured activity log that shows what each agent is doing without the noise.
- **Usage & cost analytics** - track tokens, cost, and burn rate across every project, agent, model, and effort level. Filter by any time range, watch spend by week or cumulatively, and drill into a per-project ledger with cost share, dollars per million tokens, and top agent.
- **Embedded browser** - point a sandboxed Chromium pane at any URL inside the task dialog, draw annotations, pick DOM elements, and submit the rendered frame plus context to the active agent as a multi-modal prompt, all without leaving the task.
- **Search & memory** - one overlay (Ctrl+Shift+F) searches everything on your machine: tasks, backlog, session events, projects, and every past agent conversation, by keyword or on-device semantic memory. Land on the exact turn where you solved something before, no API key required, and your agents can recall it too through the board's MCP tools.
- **Voice dictation** - hold a key, talk, release: local push-to-talk speech-to-text drops your words into the agent's terminal, transcribed on-device with a streaming preview and a refinement pass. Punctuation, language, and auto-submit are all configurable.
- **Model & effort routing** - use Opus for Planning, Sonnet for Code Review, change efforts for the harder steps. Kangentic live-applies changes as cards cross columns: no restart, no manual /model commands.
- **Your CLIs, your machine** - runs entirely on your desktop (Windows, macOS, Linux, and WSL) with no cloud service and no data leaving your machine. No OAuth, no wrappers, no API proxies: Kangentic launches the native Claude Code, Codex, Gemini, Qwen Code, Kimi Code, OpenCode, Droid, Cursor, Copilot, Aider, and Warp CLIs you already have, with your own logins and subscriptions. Just the real CLIs, the way each vendor intended.

## How It Works

1. **Create a task** - add a card with a title and prompt. Paste screenshots, choose a source branch, and toggle worktree isolation, all from the create dialog.
2. **Drag to run** - drag the card to any active column. Kangentic creates a worktree, picks the permission mode, and spawns your chosen agent automatically. Columns ship preconfigured, To Do through Done; reshape the pipeline, agents, and permissions per column anytime.
3. **Watch it code** - your agent starts writing immediately. Follow along in the live terminal: see diffs, test results, and tool calls as they happen. Drag between columns to steer, or drag to Done to pause and pick up later.

## Supported Agents

Eleven coding-agent CLIs, all first-class, on one Kanban board. Mix agents per column and hand off context between them:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic)
- [Codex CLI](https://developers.openai.com/codex/cli) (OpenAI)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) (Google)
- [Qwen Code](https://github.com/QwenLM/qwen-code) (Alibaba)
- [Kimi Code](https://github.com/MoonshotAI/kimi-cli) (Moonshot AI)
- [OpenCode](https://opencode.ai/docs) (sst)
- [Droid](https://docs.factory.ai/cli/getting-started/overview) (Factory)
- [Cursor CLI](https://cursor.com/docs/cli/overview)
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started)
- [Aider](https://aider.chat/)
- [Oz CLI](https://docs.warp.dev/reference/cli/cli) (Warp)

## Supported Boards

Bring your own backlog. Pull tasks in from the tools your team already uses, including titles, descriptions, labels, and inline images. Already-imported items are detected automatically so re-syncing is safe:

| Board | Status |
|-------|--------|
| GitHub Issues | Supported |
| GitHub Projects | Supported |
| Azure DevOps | Supported |
| Asana | Supported |
| Jira | Coming soon |
| Linear | Coming soon |
| Trello | Coming soon |
| GitLab | Coming soon |
| Obsidian | Coming soon |

## Prerequisites

- [Node.js](https://nodejs.org/) 20+ (for npx)
- [Git 2.25+](https://git-scm.com/)
- At least one supported agent CLI (see [Supported Agents](#supported-agents))

## Setup

```bash
npx kangentic
```

One command to download, install, and launch. After the first run, auto-updates handle everything.

For more details, see the [Installation & Setup guide](https://www.kangentic.com/getting-started/).

## Documentation

Get started at [kangentic.com/getting-started](https://www.kangentic.com/getting-started/).

## Development

Building from source requires Node.js 22+ (the npx floor above is for end users running the
launcher).

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for project structure, testing, and conventions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. All contributors must sign a [CLA](CLA.md) before their first PR can be merged.

## Support

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) for questions and feature requests
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) for bug reports

## License

[AGPL-3.0](LICENSE). If AGPL doesn't work for you, drop us a line at licensing@kangentic.com.

---

<h4 align="center">Built with</h4>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />
  <img src="https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/xterm.js-000000?style=for-the-badge" alt="xterm.js" />
  <img src="https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/Playwright-2EAD33?style=for-the-badge&logo=playwright&logoColor=white" alt="Playwright" />
</p>

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/brandmark-small.svg" alt="Kangentic app icon" width="26" height="26" /></a>
</p>
