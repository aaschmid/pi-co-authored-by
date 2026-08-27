/**
 * Pure logic for detecting and rewriting git commit commands with trailers.
 * Separated from the pi extension API for testability.
 */

/**
 * Check if a command is a `git commit` that supplies its message inline.
 *
 * Matches:
 * - `-m` / `-am` (short flag ending in `m`)
 * - `-F` / `--file` (message read from a file)
 * - `--message` (long form of `-m`)
 *
 * Global git options may sit between `git` and the `commit` subcommand, e.g.
 * `git -c user.name=... -c user.email=... commit -s -m "msg"`, so tokens are
 * allowed there. A shell separator (`|` `;` `&`) ends the command, so a
 * preceding piped/compound command cannot satisfy the git-commit check on its
 * own. Returns false for interactive commits (no message flag), non-commit
 * git commands, a `git commit` that sits in a later compound segment
 * (`git add X && git commit ...` — trailers must not be injected into the
 * preceding command), and a `git commit` that only appears inside a heredoc
 * body (literal text, not a command).
 *
 * ponytail: the gap between `git` and `commit` is matched with `[^|;&]*`,
 * which is not quote-aware — a `-c` value containing `|` `;` or `&` would stop
 * the match early. Realistic `-c key=value` usage does not contain separators,
 * so this is left simple; upgrade to a quote-aware scan only if a real
 * command with a separator-bearing config value shows up. A bare newline is
 * also a shell separator but is not treated as one here, so a `git commit` on
 * a later line after unrelated commands (with no `;` `&` `|` between) still
 * matches — rare in practice; the common shapes (single command, trailing
 * pipe/compound) are handled.
 */
function stripHeredocs(cmd: string): string {
	// Drop heredoc bodies so a `git commit -m` inside a heredoc (literal text,
	// not a command) is not mistaken for a real commit. Keeps the marker line;
	// drops the body and the closing delimiter line.
	//
	// ponytail: line-based, handles <<DELIM, <<-DELIM, <<'DELIM', <<"DELIM".
	// Does not handle multiple heredocs started on one line (<<A <<B) — rare;
	// upgrade only if a real case shows up.
	const lines = cmd.split("\n");
	const out: string[] = [];
	let delim: string | null = null;
	let allowIndent = false;
	for (const line of lines) {
		if (delim !== null) {
			const candidate = allowIndent ? line.replace(/^\t+/, "") : line;
			if (candidate === delim) delim = null;
			continue;
		}
		out.push(line);
		const m = line.match(/<<(-?)(['"]?)(\w+)\2/);
		if (m) {
			delim = m[3];
			allowIndent = m[1] === "-";
		}
	}
	return out.join("\n");
}

export function isGitCommit(cmd: string): boolean {
	const normalized = cmd.replace(/\\\n/g, " ");
	const stripped = stripHeredocs(normalized);
	// Only the first shell segment can receive trailers; a `git commit` in a
	// later segment (`git add && git commit ...`) must not fire, or trailers
	// would be injected into the preceding command.
	const firstSegment = splitAtShellBoundary(stripped)[0];
	if (!/\bgit\b[^|;&]*\bcommit\b/.test(firstSegment)) return false;
	// Message must be supplied inline.
	return (
		/\s-[^\s]*m\b/.test(firstSegment) || // -m, -am, -em, ...
		/\s-F\b/.test(firstSegment) ||
		/\s--file\b/.test(firstSegment) ||
		/\s--message\b/.test(firstSegment)
	);
}

/**
 * Split a command at the first top-level shell separator (`|` `;` `&`) that is
 * not inside quotes and not part of a redirection (`2>&1`, `>&2`, `&>`). The
 * trailers must be inserted before that boundary so they attach to the
 * `git commit` rather than to whatever follows a pipe (`| tail`) or a
 * compound (`&& git push`, `; echo done`).
 *
 * Returns `[before, after]` where `after` includes the separator (empty when
 * the command has no top-level boundary).
 */
function splitAtShellBoundary(cmd: string): [string, string] {
	let single = false;
	let double = false;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (single) {
			if (ch === "'") single = false;
			continue;
		}
		if (double) {
			if (ch === '"') double = false;
			continue;
		}
		if (ch === "'") {
			single = true;
			continue;
		}
		if (ch === '"') {
			double = true;
			continue;
		}
		if (ch === "|" || ch === ";") {
			return [cmd.slice(0, i), cmd.slice(i)];
		}
		if (ch === "&") {
			// Skip the `&` in redirection forms: `2>&1`, `>&2`, `&>file`.
			if (cmd[i - 1] === ">" || cmd[i + 1] === ">") continue;
			return [cmd.slice(0, i), cmd.slice(i)];
		}
	}
	return [cmd, ""];
}

/**
 * Build the rewritten command with Co-Authored-By and Generated-By trailers.
 *
 * Two insertion shapes, chosen by how the message is supplied:
 * - `-m` / `--message` (default): append ` -m "" -m $'Co-Authored-By: ...\\nGenerated-By: ...'`.
 *   git treats these as message paragraphs and appends any `-s` sign-off *after*
 *   them, so Signed-off-by stays last (the ordering the sign-off tests pin).
 * - `-F` / `--file`: append `--trailer '...' --trailer '...'`. git forbids `-m`
 *   together with `-F` ("options '-m' and '-F' cannot be used together"), so the
 *   `-m` shape would make the commit fail. `--trailer` works with `-F`; the
 *   tradeoff is that git places a `-s` sign-off *before* `--trailer` trailers,
 *   so Signed-off-by is not last on `-F` commits. `-F` is rare here (the
 *   commit-conventions skill mandates `-m`), so the commit succeeding outranks
 *   the ordering.
 */
export function appendTrailers(
	cmd: string,
	modelName: string,
	piVersion: string,
): string {
	const [before, after] = splitAtShellBoundary(cmd);
	const trimmed = before.trimEnd();
	const usesFileMessage = /(\s-F\b|\s--file\b)/.test(before);
	const insert = usesFileMessage
		? `--trailer 'Co-Authored-By: ${modelName} <noreply@pi.dev>' --trailer 'Generated-By: pi ${piVersion}'`
		: `-m "" -m $'Co-Authored-By: ${modelName} <noreply@pi.dev>\\nGenerated-By: pi ${piVersion}'`;
	return after ? `${trimmed} ${insert} ${after}` : `${trimmed} ${insert}`;
}
