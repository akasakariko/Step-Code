import { stripTerminalSequences, Text, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TuiMainScreen } from "../../../packages/tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import type { StepToolSpinnerState } from "../src/ui/view/transcript/step-spinner.ts";
import { ToolExecutionComponent } from "../src/ui/view/transcript/tool-execution.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { createStepToolProfile } from "../../../packages/coding-agent/src/step/tool-profile.ts";

const cleanups: Array<() => void> = [];

function createHarness(
	name: string,
	args: Record<string, unknown>,
	columns = 122,
	rows = 44,
	spinner?: StepToolSpinnerState,
) {
	const terminal = new VirtualTerminal(columns, rows);
	const ui = new TuiMainScreen(terminal);
	const definition = createStepToolProfile(process.cwd()).find((tool) => tool.name === name);
	const component = new ToolExecutionComponent(
		name,
		"multiline-call",
		args,
		{ presentation: "step", spinner },
		definition,
		ui,
		process.cwd(),
	);
	cleanups.push(() => ui.stop());
	return { terminal, ui, component };
}

function expectPhysicalRows(component: ToolExecutionComponent, width: number): string[] {
	const rows = component.render(width);
	for (const row of rows) {
		expect(row).not.toMatch(/[\r\n\t]/u);
		expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	}
	return rows.map(stripTerminalSequences);
}

beforeEach(() => initTheme("step-blue"));
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	initTheme("dark");
});

describe("Step projected rows", () => {
	it.each([122, 80, 40])("keeps multiline command states on physical rows at width %s", (width) => {
		// Live regression: a raw heredoc newline in the projected heading moved
		// the terminal cursor while the differential renderer counted one row.
		const command = "cat <<'EOF'\nfirst line\r\n\tsecond line\nEOF";
		const args = { command };
		const { component } = createHarness("run_command", args);
		expectPhysicalRows(component, width);
		component.setArgsComplete();
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "first line\nsecond line" }], isError: false }, true);
		expectPhysicalRows(component, width);
		component.updateResult({ content: [{ type: "text", text: "first line\nsecond line" }], isError: false }, false);
		expectPhysicalRows(component, width);
		component.setExpanded(true);
		const expanded = expectPhysicalRows(component, width).join("\n");
		expect(expanded).toContain("first line");
		expect(expanded).toContain("second line");
		expect(args.command).toBe(command);
	});

	it.each([
		["list_directory", { path: "src/one\ntwo\tdir" }],
		["read_file", { path: "src/one\rtwo.txt", start_line: 1, end_line: 2 }],
		["write_file", { path: "src/one\ntwo.txt", content: "first\nsecond" }],
		["edit_file", { path: "src/one\ntwo.txt", search: "before", replace: "after" }],
		["find_files", { path: "src/one\ntwo", pattern: "first\nsecond" }],
		["search_files", { path: "src/one\ntwo", pattern: "first\nsecond" }],
	] as const)("keeps %s titles and collapsed summaries on physical rows", (name, args) => {
		const original = JSON.stringify(args);
		const { component } = createHarness(name, args);
		expectPhysicalRows(component, 80);
		component.updateResult({ content: [{ type: "text", text: "one\ntwo" }], isError: false }, false);
		expectPhysicalRows(component, 80);
		component.setExpanded(true);
		expectPhysicalRows(component, 40);
		expect(JSON.stringify(args)).toBe(original);
	});

	it.each(["\n", "\r\n", "\r"])("previews only the first command line with %j separators", (newline) => {
		const command = ["python3 - <<'PY'", "import json", "print('done')", "PY"].join(newline);
		const { component } = createHarness("run_command", { command });
		const collapsed = expectPhysicalRows(component, 122);
		expect(collapsed[0]).toContain("run_command(python3 - <<'PY' …)");
		expect(collapsed[0]).not.toContain("import json");
		expect(collapsed.join("\n")).toContain("to expand");
	});

	it.each([122, 80, 40])("bounds heredoc input independently of output at width %s", (width) => {
		const command = [
			"python3 - <<'PY'",
			"import json",
			...Array.from({ length: 120 }, (_, i) => `print('command-${i}')`),
			"PY",
			"echo after-heredoc",
		].join("\n");
		const args = { command };
		const { component } = createHarness("run_command", args);
		component.setArgsComplete();
		const output = Array.from({ length: 20 }, (_, i) => `output-${i}`).join("\n");

		for (const state of ["running", "streaming", "success", "error"]) {
			const isError = state === "error";
			if (state !== "running") {
				component.updateResult(
					{
						content: [{ type: "text", text: isError ? `${output}\nCommand exited with code 1` : output }],
						isError,
					},
					state === "streaming",
				);
			}
			component.setExpanded(false);
			const collapsed = expectPhysicalRows(component, width);
			expect(collapsed.length, state).toBeLessThanOrEqual(10);
			expect(collapsed.join("\n"), state).not.toContain("command-60");
			expect(collapsed.join("\n"), state).toContain("to expand command");
			if (state !== "running") expect(collapsed.join("\n"), state).toContain("output-19");
			if (isError) expect(collapsed.join("\n")).toContain("Command exited with code 1");

			component.setExpanded(true);
			const expanded = expectPhysicalRows(component, width).join("\n");
			expect(expanded.match(/import json/gu), state).toHaveLength(1);
			expect(expanded, state).toContain("command-60");
			expect(expanded, state).toContain("echo after-heredoc");
			if (state !== "running") expect(expanded, state).toContain("output-0");
			expect(args.command).toBe(command);
		}
	});

	it.each([122, 80, 40])("preserves wrapped first-line input when expanded at width %s", (width) => {
		const command = `printf '${"x".repeat(240)}'`;
		const { component } = createHarness("run_command", { command });
		const collapsed = expectPhysicalRows(component, width);
		expect(collapsed).toHaveLength(3);
		expect(collapsed.join("\n")).toContain("to expand command");
		component.setExpanded(true);
		const body = expectPhysicalRows(component, width).slice(1).join("\n");
		expect(body.match(/x/gu)).toHaveLength(240);
		expect(body).toContain("$ printf");
	});

	it.each(["short output", Array.from({ length: 20 }, (_, i) => `output-${i}`).join("\n")])(
		"keeps the same output preview for single-line and multiline input: %s",
		(output) => {
			const { component: single } = createHarness("run_command", { command: "echo done" });
			const { component: multiline } = createHarness("run_command", { command: "echo done\necho more" });
			for (const component of [single, multiline]) {
				component.updateResult({ content: [{ type: "text", text: output }], isError: false }, false);
			}
			// Multiline input has its own expansion row, not part of the output budget.
			expect(expectPhysicalRows(multiline, 80).slice(2)).toEqual(expectPhysicalRows(single, 80).slice(1));
		},
	);

	it.each([
		[122, 44],
		[80, 24],
		[40, 16],
	])("does not accumulate multiline headings during redraw at %s x %s", async (columns, rows) => {
		let frame = "⠋";
		let seconds = 1;
		const spinner: StepToolSpinnerState = {
			get frame() {
				return frame;
			},
			elapsedSeconds: () => seconds,
		};
		const { terminal, ui, component } = createHarness(
			"run_command",
			{ command: "printf 'first'\nprintf 'second'\nprintf 'third'" },
			columns,
			rows,
			spinner,
		);
		ui.addChild(new Text("BEFORE_COMMAND", 0, 0));
		ui.addChild(component);
		ui.addChild(new Text("AFTER_COMMAND_FOOTER", 0, 0));
		ui.start();
		for (const nextFrame of ["⠋", "⠙", "⠹", "⠸", "⠼"]) {
			frame = nextFrame;
			seconds += 1;
			ui.renderNow();
			await terminal.flush();
		}
		component.updateResult({ content: [{ type: "text", text: "first\nsecond\nthird" }], isError: false }, false);
		ui.renderNow();
		await terminal.flush();
		const screen = terminal.getViewport().join("\n");
		expect(screen.match(/run_command\(/gu)).toHaveLength(1);
		expect(screen.match(/AFTER_COMMAND_FOOTER/gu)).toHaveLength(1);
		expect(screen).toContain("● run_command(");
	});
});
