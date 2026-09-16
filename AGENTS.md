# pi-co-authored-by — agent instructions

## Compound commands ARE rewritten

`lib/commit.ts` splits commands at top-level shell separators (`|` `;` `&&`
`||`, quote-aware, `2>&1`-safe) and appends its trailers (`Co-Authored-By`,
`Generated-By`) at the end of the **first segment that looks like a commit**:

```sh
git add x && git commit -s -m "fix: y"        # trailers land on the commit
cd repo && git commit -m "..." && git push    # middle segment, others untouched
```

Deliberate skips (not bugs, see header comment in `lib/commit.ts`):

- Commits whose preceding separator is `|` (stdin-fed, e.g. `| git commit -F -`)
  — trailer flags could collide with `-F -`.
- `git commit` inside heredoc bodies (masked out before splitting).
- A `-c key=value` with `|`/`;`/`&` inside the value (segmentIsCommit's
  `[^|;&]*` gap is not quote-aware).
- No inline message (`-m`/`-F`/`--file`/`--message` missing), e.g. bare
  `git commit` or `--amend` without `-m`.

## Editing notes

- `extensions/co-authored-by.ts` only wires the tool_call hook; all detection
  and rewriting logic lives in `lib/commit.ts` and is tested there. Change
  behavior in lib, not the extension file.
- `isGitCommit()` and `appendTrailers()` must agree on the target segment:
  both route through the same `splitSegments`/`findCommitSegment` path — don't
  fork the detection logic.
