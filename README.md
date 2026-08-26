# pi-co-authored-by

A [Pi](https://github.com/badlogic/pi) extension that automatically appends git trailers to commit messages when the agent runs `git commit`. Adds the model name and pi version so you always know which AI helped write the code.

> Forked from [bruno-garcia/pi-co-authored-by](https://github.com/bruno-garcia/pi-co-authored-by) to broaden command detection (global `-c`/`-C` options before `commit`, `-F`/`--file`/`--message` message flags) and to append trailers before trailing pipes/compound separators so they attach to the commit, not to a piped `tail`. MIT, original author Bruno Garcia.

## Features

**Co-Authored-By trailer** — Credits the model that helped write the code:
```
Co-Authored-By: Claude Sonnet 4 <noreply@pi.dev>
```

**Generated-By trailer** — Records which version of Pi was used:
```
Generated-By: pi 0.63.2
```

**Example commit:**
```
fix: resolve null pointer

Co-Authored-By: Claude Sonnet 4 <noreply@pi.dev>
Generated-By: pi 0.63.2
```

## Requirements

- [Pi](https://github.com/badlogic/pi) coding agent

## Install

```bash
pi install npm:pi-co-authored-by
```

Or try it without installing:

```bash
pi -e git:github.com/aaschmid/pi-co-authored-by
```

Install from git (this fork):

```bash
pi install git:github.com/aaschmid/pi-co-authored-by
```

## How it works

The extension hooks into Pi's `tool_call` event. When it detects a `git commit -m` command, it appends two extra `-m` flags to create [git trailers](https://git-scm.com/docs/git-interpret-trailers) with the current model name and pi version.

| What | Value |
|------|-------|
| `Co-Authored-By` | Model name (e.g., `Claude Sonnet 4`) |
| `Generated-By` | Pi version (e.g., `pi 0.52.12`) |

## Development

```bash
npm install
npm test
```

## License

MIT
