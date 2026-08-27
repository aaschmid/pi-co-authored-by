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
 * own. Returns false for interactive commits (no message flag) and non-commit
 * git commands.
 *
 * ponytail: the gap between `git` and `commit` is matched with `[^|;&]*`,
 * which is not quote-aware — a `-c` value containing `|` `;` or `&` would stop
 * the match early. Realistic `-c key=value` usage does not contain separators,
 * so this is left simple; upgrade to a quote-aware scan only if a real
 * command with a separator-bearing config value shows up.
 */
export function isGitCommit(cmd: string): boolean {
	const normalized = cmd.replace(/\\\n/g, " ");
	if (!/\bgit\b[^|;&]*\bcommit\b/.test(normalized)) return false;
	// Message must be supplied inline.
	return (
		/\s-[^\s]*m\b/.test(normalized) || // -m, -am, -em, ...
		/\s-F\b/.test(normalized) ||
		/\s--file\b/.test(normalized) ||
		/\s--message\b/.test(normalized)
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
