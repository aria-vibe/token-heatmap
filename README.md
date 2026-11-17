# token-heatmap

A Claude Code mod that brings back a token usage heatmap. Each session opens a **Token activity** pane beside the chat with a GitHub-style grid of how many tokens you used per day.

- **Past month / Past 6 months** toggle
- **All tokens** (including cache reads and writes) or **Input + output** only
- Totals for the period: tokens, output tokens, today, active days, peak day, current and best streak
- Hover a day for its input, output, cache and reply counts
- When the desktop app minimises the pane, it shows today's tokens and a 30-day strip
- `/token-heatmap` reopens the pane

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install token-heatmap --marketplace aria-vibe/token-heatmap
```

Answer `y` to add the marketplace, then pick a scope (user scope puts it in every session). New sessions open the pane by themselves, in the terminal and in the desktop app.

## How it works

The mod reads your local transcripts in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`) with `find` and `awk`. It does this when a session starts, every 10 minutes, and when you press **Refresh**. Claude Code writes a reply's usage on several rows, and resumed sessions copy old rows, so the scan counts each request once. Days are bucketed in your local time zone.

Claude Code deletes transcripts after a while (`cleanupPeriodDays`, 30 days by default), so the first scan only sees recent history. The mod keeps its own daily totals in its plugin store, so the 6-month view fills in as you keep using it.

Nothing leaves your machine: the mod makes no network requests.

## Requirements

macOS or Linux, with `/usr/bin/find`, `/usr/bin/awk` and `/bin/date`. Windows is not supported.

## Development

```
claude plugin validate .
claude plugin test .
```

## License

MIT
