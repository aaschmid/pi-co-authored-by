/**
 * Pure logic for detecting and rewriting git commit commands with trailers.
 * Separated from the pi extension API for testability.
 *
 * Commands may be compounds (`git add X && git commit -m ...`,
 * `cd repo ; git commit ...`): trailers are appended at the end of the FIRST
 * segment that looks like a commit, leaving every other segment untouched.
 * Segments fed through a pipe (preceding separator `|`) are never rewritten —
 * they may read their message from stdin (`git commit -F -`).
 */

/**
 * Replace heredoc bodies (and their closing delimiter line) with spaces of the
 * same length, so splitting/detection cannot mistake heredoc text for commands
 * — while offsets in the masked string stay valid in the original.
 *
 * ponytail: line-based, handles <<DELIM, <<-DELIM, <<'DELIM', <<"DELIM".
 * Does not handle multiple heredocs started on one line (<<A <<B) — rare;
 * upgrade only if a real case shows up.
 */
function maskHeredocs(cmd: string): string {
	const lines = cmd.split("\n");
	const out: string[] = [];
	let delim: string | null = null;
	let allowIndent = false;
	for (const line of lines) {
		if (delim !== null) {
			const candidate = allowIndent ? line.replace(/^\t+/, "") : line;
			if (candidate === delim) delim = null;
			out.push(" ".repeat(line.length));
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

/**
 * Split the masked command at top-level shell separators (`|` `;` `&` `&&`
 * `||`), quote-aware and ignoring redirections (`2>&1`, `>&2`, `&>`). Returns
 * each segment's byte range in `masked` (identical offsets in the original)
 * plus the separator that follows it.
 *
 * ponytail: a bare newline is not a separator, so a segment may span lines;
 * a heredoc marker line containing `|`/`;`/`&` would be split — neither
 * realistic for `git commit` shapes; upgrade to a full mask-aware pass only
 * if a real command shows up.
 */
function splitSegments(
	masked: string,
): { start: number; end: number; sep: string }[] {
	const segs: { start: number; end: number; sep: string }[] = [];
	let start = 0;
	let single = false;
	let double = false;
	for (let i = 0; i < masked.length; i++) {
		const ch = masked[i];
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
		const isSep =
			ch === ";" ||
			ch === "|" ||
			(ch === "&" && masked[i - 1] !== ">" && masked[i + 1] !== ">");
		if (!isSep) continue;
		const sepLen = masked[i + 1] === ch && ch !== ";" ? 2 : 1;
		segs.push({ start, end: i, sep: masked.slice(i, i + sepLen) });
		start = i + sepLen;
		i += sepLen - 1;
	}
	segs.push({ start, end: masked.length, sep: "" });
	return segs;
}

/** Does this segment text contain a `git commit` supplying its message inline?
 *
 * ponytail: the gap between `git` and `commit` is matched with `[^|;&]*`,
 * which is not quote-aware — a `-c` value containing `|` `;` or `&` would stop
 * the match early. Realistic `-c key=value` usage does not contain separators;
 * upgrade to a quote-aware scan only if a real config value shows up. */
function segmentIsCommit(seg: string): boolean {
	const normalized = seg.replace(/\\\n/g, " ");
	if (!/\bgit\b[^|;&]*\bcommit\b/.test(normalized)) return false;
	// Message must be supplied inline.
	return (
		/\s-[^\s]*m\b/.test(normalized) || // -m, -am, -em, ...
		/\s-F\b/.test(normalized) ||
		/\s--file\b/.test(normalized) ||
		/\s--message\b/.test(normalized)
	);
}

/** Index of the first commit-bearing segment that is not pipe-fed, or -1. */
function findCommitSegment(
	masked: string,
	segs: { start: number; end: number; sep: string }[],
): number {
	for (let i = 0; i < segs.length; i++) {
		if (i > 0 && segs[i - 1].sep === "|") continue;
		if (segmentIsCommit(masked.slice(segs[i].start, segs[i].end))) return i;
	}
	return -1;
}

export function isGitCommit(cmd: string): boolean {
	const masked = maskHeredocs(cmd);
	return findCommitSegment(masked, splitSegments(masked)) !== -1;
}

/**
 * Build the rewritten command with Co-Authored-By and Generated-By trailers,
 * appended at the end of the first commit-bearing segment (see module header).
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
	const masked = maskHeredocs(cmd);
	const segs = splitSegments(masked);
	const idx = findCommitSegment(masked, segs);
	// Callers gate on isGitCommit; fall back to the original command if not.
	if (idx === -1) return cmd;

	const seg = segs[idx];
	const segText = cmd.slice(seg.start, seg.end);
	const usesFileMessage = /(\s-F\b|\s--file\b)/.test(segText);
	const insert = usesFileMessage
		? `--trailer 'Co-Authored-By: ${modelName} <noreply@pi.dev>' --trailer 'Generated-By: pi ${piVersion}'`
		: `-m "" -m $'Co-Authored-By: ${modelName} <noreply@pi.dev>\\nGenerated-By: pi ${piVersion}'`;
	const newText = `${segText.trimEnd()} ${insert}${seg.sep ? " " : ""}`;
	return `${cmd.slice(0, seg.start)}${newText}${cmd.slice(seg.end)}`;
}
