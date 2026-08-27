import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendTrailers, isGitCommit } from "./commit.ts";

describe("isGitCommit", () => {
	it("detects git commit -m", () => {
		expect(isGitCommit('git commit -m "fix bug"')).toBe(true);
	});

	it("detects git commit -am", () => {
		expect(isGitCommit('git commit -am "fix bug"')).toBe(true);
	});

	it("detects git commit with flags before -m", () => {
		expect(isGitCommit('git commit --allow-empty -m "init"')).toBe(true);
	});

	it("detects git commit with flags after -m", () => {
		expect(isGitCommit('git commit -m "msg" --no-verify')).toBe(true);
	});

	it("detects git commit -m without space before value", () => {
		expect(isGitCommit('git commit -m"no space"')).toBe(true);
	});

	it("detects git commit with line continuation", () => {
		expect(isGitCommit('git commit \\\n-m "msg"')).toBe(true);
	});

	it("rejects interactive git commit (no -m)", () => {
		expect(isGitCommit("git commit")).toBe(false);
	});

	it("rejects git commit --amend without -m", () => {
		expect(isGitCommit("git commit --amend")).toBe(false);
	});

	it("rejects non-commit git commands", () => {
		expect(isGitCommit("git log --oneline")).toBe(false);
	});

	it("rejects git status", () => {
		expect(isGitCommit("git status")).toBe(false);
	});

	it("rejects git push", () => {
		expect(isGitCommit("git push origin main")).toBe(false);
	});

	it("rejects empty string", () => {
		expect(isGitCommit("")).toBe(false);
	});

	it("detects git commit --amend -m (amend with new message)", () => {
		expect(isGitCommit('git commit --amend -m "new msg"')).toBe(true);
	});

	it("detects git commit with -S (signed) and -m", () => {
		expect(isGitCommit('git commit -S -m "signed commit"')).toBe(true);
	});

	it("detects git -c ... commit (global options before commit)", () => {
		expect(
			isGitCommit('git -c user.name="x" -c user.email="y" commit -s -m "msg"'),
		).toBe(true);
	});

	it("detects git -C /path commit -m", () => {
		expect(isGitCommit('git -C /repo commit -m "msg"')).toBe(true);
	});

	it("detects git commit -F (message from file)", () => {
		expect(isGitCommit("git commit -F CHANGES")).toBe(true);
	});

	it("detects git commit --file", () => {
		expect(isGitCommit("git commit --file CHANGES")).toBe(true);
	});

	it("detects git commit --message=foo (long form with =)", () => {
		expect(isGitCommit("git commit --message=foo")).toBe(true);
	});

	it("detects git commit -F combined with -m", () => {
		expect(isGitCommit('git commit -F body -m "trailer"')).toBe(true);
	});

	it("detects a piped git commit", () => {
		expect(isGitCommit('git -c x=y commit -s -m "msg" 2>&1 | tail -20')).toBe(
			true,
		);
	});

	it("rejects git -c ... commit without a message flag", () => {
		expect(isGitCommit("git -c x=y commit")).toBe(false);
	});

	it("rejects git -c ... log (global options on a non-commit command)", () => {
		expect(isGitCommit("git -c x=y log --oneline")).toBe(false);
	});
});

describe("appendTrailers", () => {
	it("appends trailers to a simple commit command", () => {
		const result = appendTrailers(
			'git commit -m "fix bug"',
			"Claude Sonnet 4",
			"0.52.12",
		);
		expect(result).toBe(
			`git commit -m "fix bug" -m "" -m $'Co-Authored-By: Claude Sonnet 4 <noreply@pi.dev>\\nGenerated-By: pi 0.52.12'`,
		);
	});

	it("trims trailing whitespace from original command", () => {
		const result = appendTrailers(
			'git commit -m "fix"   ',
			"Claude Sonnet 4",
			"0.52.12",
		);
		expect(result).toMatch(/^git commit -m "fix" -m/);
		expect(result).not.toMatch(/\s{2,}-m ""/);
	});

	it("includes model name in Co-Authored-By", () => {
		const result = appendTrailers(
			'git commit -m "msg"',
			"Gemini 2.5 Pro",
			"1.0.0",
		);
		expect(result).toContain("Co-Authored-By: Gemini 2.5 Pro <noreply@pi.dev>");
	});

	it("includes pi version in Generated-By", () => {
		const result = appendTrailers('git commit -m "msg"', "Some Model", "1.2.3");
		expect(result).toContain("Generated-By: pi 1.2.3");
	});

	it("uses $'' quoting for the trailer block", () => {
		const result = appendTrailers('git commit -m "msg"', "Model", "1.0.0");
		// The trailers should be in a single $'...' string with \\n separator
		expect(result).toMatch(/-m \$'Co-Authored-By:.*\\nGenerated-By:.*'/);
	});

	it("handles model name with special characters", () => {
		const result = appendTrailers(
			'git commit -m "msg"',
			"openai/gpt-4o",
			"0.50.0",
		);
		expect(result).toContain("Co-Authored-By: openai/gpt-4o <noreply@pi.dev>");
	});

	it("inserts trailers before a trailing pipe (not onto the piped command)", () => {
		const result = appendTrailers(
			'git commit -m "msg" 2>&1 | tail -20',
			"Model",
			"1.0.0",
		);
		const trailerIdx = result.indexOf("-m $");
		const pipeIdx = result.indexOf("| tail");
		expect(pipeIdx).toBeGreaterThan(trailerIdx);
		expect(result).toMatch(/ -m \$'Co-Authored-By.*' \| tail/);
		// The pipe target must not receive the -m flags.
		expect(result).not.toMatch(/tail.*-m /);
	});

	it("inserts trailers before a semicolon", () => {
		const result = appendTrailers(
			'git commit -m "msg" ; echo done',
			"Model",
			"1.0.0",
		);
		expect(result).toMatch(/ -m \$'Co-Authored-By.*' ; echo done/);
	});

	it("inserts trailers before &&", () => {
		const result = appendTrailers(
			'git commit -m "msg" && git push',
			"Model",
			"1.0.0",
		);
		expect(result).toMatch(/ -m \$'Co-Authored-By.*' && git push/);
		expect(result).not.toMatch(/git push.*-m /);
	});

	it("does not split on the & in 2>&1 (redirection, not a separator)", () => {
		const result = appendTrailers('git commit -m "msg" 2>&1', "Model", "1.0.0");
		// No trailing pipe/separator, so trailers go at the very end.
		expect(result).toBe(
			'git commit -m "msg" 2>&1 -m "" -m $' +
				`'Co-Authored-By: Model <noreply@pi.dev>\\nGenerated-By: pi 1.0.0'`,
		);
	});

	it("does not split on a separator inside single quotes", () => {
		const result = appendTrailers('git commit -m "a; b | c"', "Model", "1.0.0");
		expect(result).toMatch(/ -m \$'Co-Authored-By.*'$/);
		expect(result).not.toMatch(/ -m \$'Co-Authored-By.*' [|;]/);
	});

	it("appends trailers to a -F commit", () => {
		const result = appendTrailers("git commit -F CHANGES", "Model", "1.0.0");
		expect(result).toBe(
			`git commit -F CHANGES --trailer 'Co-Authored-By: Model <noreply@pi.dev>' --trailer 'Generated-By: pi 1.0.0'`,
		);
	});

	it("a -F commit with trailers actually succeeds (regression: -m + -F rejected)", () => {
		const dir = mkdtempSync(join(tmpdir(), "coauth-f-"));
		try {
			execSync("git init -q", { cwd: dir });
			execSync("git config user.email t@t.t", { cwd: dir });
			execSync("git config user.name tester", { cwd: dir });
			writeFileSync(join(dir, "a"), "a");
			execSync("git add a", { cwd: dir });
			writeFileSync(join(dir, "MSG"), "msg from file");
			const cmd = appendTrailers("git commit -F MSG", "Model", "1.0.0");
			// pi runs commits through /bin/bash (its shell backend); execSync defaults
			// to /bin/sh, which is dash on the Ubuntu runner and breaks $'...' quoting
			// used by the -m trailer shape. Mirror production's shell.
			execSync(cmd, { cwd: dir, shell: "/bin/bash" }); // throws on non-zero exit
			const body = execSync("git log -1 --format=%B", { cwd: dir }).toString();
			expect(body).toContain("msg from file");
			expect(body).toContain("Co-Authored-By: Model <noreply@pi.dev>");
			expect(body).toContain("Generated-By: pi 1.0.0");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("sign-off (-s)", () => {
	it("detects git commit -s (sign-off) with -m", () => {
		expect(isGitCommit('git commit -s -m "msg"')).toBe(true);
	});

	it("detects git commit -as (stage-all + sign-off) with -m", () => {
		expect(isGitCommit('git commit -as -m "msg"')).toBe(true);
	});

	it("appendTrailers preserves the -s flag in the rewritten command", () => {
		const result = appendTrailers('git commit -s -m "msg"', "Model", "1.0.0");
		expect(result).toMatch(/\s-s\s/);
		expect(result).toContain("-m $'Co-Authored-By:");
	});

	it("leaves Signed-off-by as the last trailer when -s is present", () => {
		const dir = mkdtempSync(join(tmpdir(), "coauth-s-"));
		try {
			execSync("git init -q", { cwd: dir });
			execSync("git config user.email t@t.t", { cwd: dir });
			execSync("git config user.name tester", { cwd: dir });
			writeFileSync(join(dir, "a"), "a");
			execSync("git add a", { cwd: dir });
			const cmd = appendTrailers(
				'git commit -s -m "fix" -m "body"',
				"Model",
				"1.0.0",
			);
			execSync(cmd, { cwd: dir, shell: "/bin/bash" });
			const body = execSync("git log -1 --format=%B", { cwd: dir }).toString();
			const trailers = body
				.split("\n")
				.filter((l) => /^(Signed-off-by|Co-Authored-By|Generated-By):/.test(l));
			expect(trailers.length).toBe(3);
			expect(trailers[trailers.length - 1]).toMatch(/^Signed-off-by:/);
			expect(trailers.some((l) => l.startsWith("Co-Authored-By: Model"))).toBe(
				true,
			);
			expect(trailers.some((l) => l.startsWith("Generated-By: pi 1.0.0"))).toBe(
				true,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("compound commands and heredocs (regression)", () => {
	it("does not fire when git commit is in a later && segment", () => {
		// `git add X && git commit ...` — firing would inject trailers into
		// `git add`, breaking it. Skip the whole compound instead.
		expect(
			isGitCommit('git add package-lock.json && git commit -s -m "fix: x"'),
		).toBe(false);
	});

	it("does not fire when git commit is in a later ; segment", () => {
		expect(isGitCommit('echo hi ; git commit -m "msg"')).toBe(false);
	});

	it("fires when git commit is the first segment, injects before &&", () => {
		const result = appendTrailers(
			'git commit -m "msg" && git push',
			"Model",
			"1.0.0",
		);
		expect(result).toMatch(/ -m \$'Co-Authored-By.*' && git push/);
		expect(result).not.toMatch(/git push.*-m /);
	});

	it("does not fire when git commit -m appears only inside a heredoc body", () => {
		const cmd = [
			"cat > file <<'EOF'",
			'some text mentioning git commit -m "x"',
			"EOF",
		].join("\n");
		expect(isGitCommit(cmd)).toBe(false);
	});

	it("strips a heredoc body and detects a following real git commit", () => {
		const cmd = ["cat > f <<'EOF'", "body", "EOF", 'git commit -m "msg"'].join(
			"\n",
		);
		expect(isGitCommit(cmd)).toBe(true);
		const result = appendTrailers(cmd, "Model", "1.0.0");
		expect(result).toContain('git commit -m "msg"');
		expect(result).toContain("Co-Authored-By: Model");
	});
});
