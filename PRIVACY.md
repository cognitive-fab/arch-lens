# Privacy

arch-lens runs on your machine. It has no server, no account and no telemetry,
and Cognitive Fab receives nothing from it.

## What it reads

- The files of the repository you point it at: source code, compose files,
  `package.json` workspaces, and any architecture or design document you name
  as a source. A PDF is read through `pdftotext` when it is installed.
- Local git history, through the `git` command: the current revision, and what
  changed since the revision an analysis was written against. It reads no
  commit authors or emails.
- One setting, to find the archify renderer: the `archify_path` plugin option,
  or the `ARCHLENS_ARCHIFY` environment variable. Without either, it checks
  whether archify is installed under `~/.claude/skills`, `~/.cursor/skills`,
  `~/.codex/skills`, `~/.config/opencode/skill` or `node_modules`. It checks
  only whether `bin/archify.mjs` exists there and reads nothing else.

It reads no credentials, tokens or keys, and no personal data.

## What it writes

Only files in your repository, where you tell it to: the analysis
(`*.analysis.json`), and the diagrams (HTML) and markdown document compiled
from it. `scripts/install-skill.mjs`, if you run it, copies the skill into
your agent's skills folder.

## What leaves your machine

arch-lens makes no network requests. The rendered diagram pages are produced
by archify, a separate tool you install yourself. Its page template loads the
JetBrains Mono font from Google Fonts, so opening a diagram in a browser
requests that font from Google. So does archify's local browser check, which
arch-lens runs after rendering. That request carries your IP address and the
font name, as any web font does; none of the analysis or your code is sent.
Source links in a diagram point at your repository's host and are followed
only when you click them.

When you use arch-lens through Claude Code, Claude reads your code and the
files arch-lens produces as part of your session. That is governed by your
agreement with Anthropic, not by this plugin.

## Contact

Questions: open an issue at https://github.com/cognitive-fab/arch-lens/issues.
