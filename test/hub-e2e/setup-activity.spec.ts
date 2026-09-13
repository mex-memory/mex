import { expect, test } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const privateSentinel = "PRIVATE_PROTOCOL_SESSION_AND_REASONING";
const assistantText = "Reading the project guide before updating architecture notes.";
const laterAssistantText = "Architecture notes are updated. Checking the remaining project memory.";
const commandText = "cat README.md";
const outputText = "Project guide read successfully.";
const literalHtml = '<img src=x onerror="globalThis.transcriptInjected = true">';
const finalAssistantText = "Finished the synthetic tool activity. Continuing project memory setup.";
type Provider = "claude" | "codex";

test.describe("built setup activity stream", () => {
  for (const provider of ["claude", "codex"] as const) {
    test(`${provider} streams real subprocess activity, survives reload, and cancels cleanly`, async ({ page }, testInfo) => {
      const fixture = createFixture();
      let hub: ChildProcess | undefined;
      try {
        hub = spawn(process.execPath, [join(repositoryRoot, "dist", "cli.js"), "hub", "--no-open"], {
          cwd: fixture.project,
          env: fixture.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        const bootstrap = await readBootstrapUrl(hub);
        const origin = new URL(bootstrap).origin;
        const externalRequests: string[] = [];
        const pageErrors: string[] = [];
        page.on("request", (request) => {
          if (new URL(request.url()).origin !== origin) externalRequests.push(request.url());
        });
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(bootstrap);
        await page.getByRole("button", { name: "Set up this project", exact: true }).click();
        await page.getByRole("radio", { name: /Agent memory/ }).check();
        // Both names are shimmed; an installed real CLI can never be selected
        // accidentally, even when the developer has saved tool preferences.
        for (const checkbox of await page.getByRole("checkbox").all()) await checkbox.uncheck();
        await page.locator(`input[name="setup-tools"][value="${provider}"]`).check();
        const cdp = await page.context().newCDPSession(page);
        const hiddenDetails = [privateSentinel, commandText, outputText, ".mex/context/architecture.md",
          "# Architecture notes", "Architecture file written.", "fixture-output", "SYNTHETIC OUTPUT", fixture.project];
        const transcriptRequests = new Set<string>();
        const wireKinds = new Set<string>();
        const wireDetails = new Set<string>();
        const wireAssistantEntryIds = new Set<number>();
        let wireMessages = 0;
        let wireAssistantSeen = false;
        let wireCommandSeen = false;
        let wireFileSeen = false;
        await cdp.send("Network.enable");
        cdp.on("Network.requestWillBeSent", (event) => {
          if (new URL(event.request.url).pathname === "/api/v1/setup/transcript/events" && transcriptRequests.size < 16) {
            transcriptRequests.add(event.requestId);
          }
        });
        cdp.on("Network.eventSourceMessageReceived", (event) => {
          if (!transcriptRequests.has(event.requestId) || event.eventName !== "transcript") return;
          wireMessages++;
          for (const detail of hiddenDetails) if (event.data.includes(detail)) wireDetails.add(detail);
          const batch = JSON.parse(event.data) as { entries: Array<{ id: number; kind: string; text: string }> };
          for (const entry of batch.entries) {
            wireKinds.add(entry.kind);
            wireAssistantSeen ||= entry.kind === "assistant" && entry.text.includes(assistantText);
            if (entry.kind === "assistant" && entry.text.includes(assistantText)) wireAssistantEntryIds.add(entry.id);
            wireCommandSeen ||= entry.text === "Ran a command";
            wireFileSeen ||= entry.text === "Updated a file";
          }
        });
        const measureBrowser = async () => {
          await cdp.send("HeapProfiler.collectGarbage");
          return { heap: await cdp.send("Runtime.getHeapUsage"), dom: await cdp.send("Memory.getDOMCounters") };
        };
        const baseline = await measureBrowser();
        await page.getByRole("button", { name: "Start setup", exact: true }).click();

        const name = provider === "claude" ? "Claude Code" : "Codex";
        const activity = page.getByRole("region", { name: `${name} is building your project memory`, exact: true });
        const transcript = page.getByRole("region", { name: "Agent session transcript", exact: true });
        await expect(activity).toBeVisible();
        await expect(page.getByText("Session output", { exact: true })).toBeVisible();
        await expect(transcript).toContainText(assistantText);
        await expect(transcript).toContainText("Ran a command");
        const typography = await transcript.locator('[data-kind="assistant"]').first().evaluate((element) => {
          const prose = element.querySelector("p") ?? element;
          const style = getComputedStyle(prose);
          return { fontFamily: style.fontFamily, fontSize: style.fontSize,
            whiteSpace: style.whiteSpace };
        });
        expect(typography.fontFamily).not.toMatch(/monospace/iu);
        expect(Number.parseFloat(typography.fontSize)).toBeGreaterThanOrEqual(12);
        expect(typography.whiteSpace).toBe("pre-wrap");
        await expect(page.getByRole("progressbar")).toHaveCount(0);
        await expect(page.locator("#setup-main")).not.toContainText(/\b\d+%/);
        await expect(activity).toContainText("Running for");
        await expect(activity).toContainText("Last activity");

        const observed = readObservation(fixture.project);
        expect(observed.provider).toBe(provider);
        expect(existsSync(join(fixture.project, observed.prompt))).toBe(true);
        expect(readFileSync(join(fixture.project, observed.prompt), "utf8").length).toBeGreaterThan(0);
        // Release the next real stdout records only after the initial activity
        // was rendered. This proves delivery through SSE, not just a start GET.
        writeFileSync(join(fixture.project, "continue-activity"), "continue");
        await expect(transcript).toContainText("Updated a file");
        await expect(transcript).toContainText(laterAssistantText);
        await expect(transcript).toContainText(literalHtml);
        expect((await transcript.textContent())!.split(assistantText).length - 1).toBe(1);
        await expect(transcript.locator("img, script")).toHaveCount(0);
        for (const detail of hiddenDetails) await expect(page.locator("body")).not.toContainText(detail);
        await page.screenshot({ path: testInfo.outputPath(`${provider}-transcript.png`), fullPage: true });
        const retainedText = provider === "codex" ? finalAssistantText : laterAssistantText;
        if (provider === "codex") {
          writeFileSync(join(fixture.project, "bulk-activity"), "continue");
          await expect(transcript).toContainText(retainedText);
        }
        const renderedRows = await transcript.locator("[data-kind]").count();
        const renderedCharacters = await transcript.locator("[data-kind]").evaluateAll((nodes) =>
          nodes.reduce((sum, node) => sum + (node.textContent?.length ?? 0), 0));
        expect(renderedRows).toBeLessThanOrEqual(80);
        expect(renderedCharacters).toBeLessThanOrEqual(32_768);
        const populated = await measureBrowser();
        const memoryPath = testInfo.outputPath("synthetic-transcript-browser-memory.json");
        writeFileSync(memoryPath, JSON.stringify({
          provider, scope: "Browser-only synthetic executable fixture; no live AI provider. Forced GC before each observation.",
          syntheticOutputRecords: provider === "codex" ? 400 : 1,
          baseline, populated, retainedHeapDeltaBytes: populated.heap.usedSize - baseline.heap.usedSize,
          renderedRows, renderedCharacters, typography,
        }, null, 2));
        await testInfo.attach("synthetic-transcript-browser-memory", {
          contentType: "application/json",
          path: memoryPath,
        });

        const [snapshotResponse] = await Promise.all([
          page.waitForResponse((response) => response.request().method() === "GET"
            && new URL(response.url()).pathname === "/api/v1/setup/run"),
          page.reload(),
        ]);
        expect(snapshotResponse.status()).toBe(200);
        await expect(activity).toBeVisible();
        await expect(transcript).toContainText(retainedText);
        await expect(page.getByRole("progressbar")).toHaveCount(0);
        expect(readObservation(fixture.project).pid).toBe(observed.pid);
        expect(readFileSync(join(fixture.project, "agent-starts"), "utf8")).toBe("1");
        expect(existsSync(join(fixture.project, observed.prompt))).toBe(true);

        const [cancelResponse] = await Promise.all([
          page.waitForResponse((response) => response.request().method() === "POST"
            && new URL(response.url()).pathname === "/api/v1/setup/cancel"),
          page.getByRole("button", { name: "Cancel setup", exact: true }).click(),
        ]);
        expect(cancelResponse.status()).toBe(202);
        await expect(page.getByText("Setup cancelled", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Resume setup", exact: true })).toBeVisible();
        await expect(transcript).toBeVisible();
        await expect(transcript).toContainText(retainedText);
        await expect.poll(() => existsSync(join(fixture.project, observed.prompt))).toBe(false);
        await expect.poll(() => processExists(observed.pid)).toBe(false);
        expect(wireMessages).toBeGreaterThan(0);
        expect(wireAssistantSeen).toBe(true);
        expect([...wireAssistantEntryIds]).toHaveLength(1);
        expect(wireCommandSeen).toBe(true);
        expect(wireFileSeen).toBe(true);
        expect([...wireDetails]).toEqual([]);
        expect([...wireKinds]).not.toContain("output");
        for (const detail of hiddenDetails) await expect(page.locator("body")).not.toContainText(detail);
        const wirePath = testInfo.outputPath("transcript-wire-verification.json");
        writeFileSync(wirePath, JSON.stringify({ provider, messages: wireMessages,
          kinds: [...wireKinds], assistantSeen: wireAssistantSeen,
          initialAssistantEntryIds: [...wireAssistantEntryIds],
          commandMarkerSeen: wireCommandSeen, fileMarkerSeen: wireFileSeen,
          leakedDetailSentinels: [...wireDetails] }, null, 2));
        await testInfo.attach("transcript-wire-verification", { contentType: "application/json", path: wirePath });
        expect(pageErrors).toEqual([]);
        expect(externalRequests).toEqual([]);
      } finally {
        try {
          if (hub) await stopHub(hub);
        } finally {
          // The fallback is only for failed assertions or a broken shutdown.
          // Cleanup still owns the exact fixture child before deleting its files.
          const observation = join(fixture.project, "agent-observation.json");
          if (existsSync(observation)) await stopFixtureAgent(readObservation(fixture.project).pid);
          rmSync(fixture.root, { recursive: true, force: true });
        }
      }
    });
  }
});

function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-setup-activity-browser-")));
  const project = join(root, "project");
  const bin = join(root, "bin");
  mkdirSync(project);
  mkdirSync(bin);
  writeFileSync(join(project, "README.md"), "# Disposable setup activity fixture\n");
  const script = join(root, "replay-agent.cjs");
  writeFileSync(script, `
    const fs = require('node:fs');
    const provider = process.argv[2];
    const args = process.argv.slice(3);
    const instruction = args.find(value => value.startsWith('Read the full setup population prompt'));
    if (!instruction || (provider === 'codex' ? !args.includes('--json') : !args.includes('stream-json'))) process.exit(2);
    const prompt = instruction.split(String.fromCharCode(96))[1];
    fs.readFileSync(prompt, 'utf8');
    const starts = fs.existsSync('agent-starts') ? Number(fs.readFileSync('agent-starts', 'utf8')) : 0;
    fs.writeFileSync('agent-starts', String(starts + 1));
    fs.writeFileSync('agent-observation.json.tmp', JSON.stringify({ provider, pid: process.pid, prompt }));
    fs.renameSync('agent-observation.json.tmp', 'agent-observation.json');
    const send = value => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));
    const privateText = ${JSON.stringify(privateSentinel)};
    const assistantText = ${JSON.stringify(assistantText)} + String.fromCharCode(10) + ${JSON.stringify(literalHtml)};
    const laterAssistantText = ${JSON.stringify(laterAssistantText)};
    const commandText = ${JSON.stringify(commandText)};
    const outputText = ${JSON.stringify(outputText)};
    if (provider === 'codex') {
      send({ type: 'thread.started', thread_id: privateText });
      send({ type: 'turn.started' });
      send({ type: 'item.completed', item: { id: 'reasoning_1', type: 'reasoning', text: privateText } });
      send({ type: 'item.completed', item: { id: 'message_1', type: 'agent_message', text: assistantText } });
      send({ type: 'item.started', item: { id: 'command_1', type: 'command_execution', command: commandText, status: 'in_progress' } });
    } else {
      send({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: privateText });
      send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'message_1', role: 'assistant', type: 'message', content: [] } } });
      send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
      send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: assistantText } } });
      send({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
      // The tool boundary flushes streamed prose before Claude's complete
      // envelope repeats that same text. The UI must receive it only once.
      send({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'read_1', name: 'Bash', input: {} } } });
      send({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: commandText }) } } });
      send({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
      send({ type: 'assistant', message: { id: 'message_1', content: [
        { type: 'text', text: assistantText }, { type: 'thinking', thinking: privateText },
        { type: 'tool_use', id: 'read_1', name: 'Bash', input: { command: commandText } },
      ] } });
      send({ type: 'stream_event', event: { type: 'message_stop' } });
    }
    let released = false;
    let bulkReleased = false;
    const timer = setInterval(() => {
      if (!released && fs.existsSync('continue-activity')) {
        released = true;
        if (provider === 'codex') {
          send({ type: 'item.completed', item: { id: 'command_1', type: 'command_execution', status: 'completed', exit_code: 0, aggregated_output: outputText } });
          send({ type: 'item.completed', item: { id: 'patch_1', type: 'file_change', status: 'completed', changes: [{ path: '.mex/context/architecture.md', kind: 'update' }] } });
          send({ type: 'item.completed', item: { id: 'message_2', type: 'agent_message', text: laterAssistantText } });
        } else {
          send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read_1', content: outputText }] } });
          send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'write_1', name: 'Write', input: { file_path: '.mex/context/architecture.md', content: '# Architecture notes' } }] } });
          send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write_1', content: 'Architecture file written.' }] } });
          send({ type: 'assistant', message: { id: 'message_2', content: [{ type: 'text', text: laterAssistantText }] } });
        }
      }
      if (provider === 'codex' && !bulkReleased && fs.existsSync('bulk-activity')) {
        bulkReleased = true;
        for (let index = 0; index < 400; index++) {
          send({ type: 'item.completed', item: { id: 'bulk_' + index, type: 'command_execution', command: 'fixture-output', status: 'completed', exit_code: 0,
            aggregated_output: 'SYNTHETIC OUTPUT ' + String(index).padStart(4, '0') + ' ' + 'x'.repeat(512) } });
        }
        send({ type: 'item.completed', item: { id: 'message_3', type: 'agent_message', text: ${JSON.stringify(finalAssistantText)} } });
      }
    }, 25);
    // Successful cancellation must close this still-running child. This fixed
    // deadline also bounds a fixture left running by a failed test assertion.
    setTimeout(() => { clearInterval(timer); process.exit(3); }, 20_000);
  `);
  for (const provider of ["claude", "codex"]) {
    if (process.platform === "win32") {
      writeFileSync(join(bin, `${provider}.cmd`), `@"${process.execPath}" "${script}" "${provider}" %*\r\n`);
    } else {
      const executable = join(bin, provider);
      writeFileSync(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} ${provider} "$@"\n`);
      chmodSync(executable, 0o755);
    }
  }
  const env: NodeJS.ProcessEnv = { ...process.env, MEX_HOME: join(root, "home"), MEX_TELEMETRY: "0", NO_COLOR: "1" };
  // Windows environment names are case-insensitive; do not leave two PATHs.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  return { root, project, env };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readObservation(project: string): { provider: Provider; pid: number; prompt: string } {
  return JSON.parse(readFileSync(join(project, "agent-observation.json"), "utf8"));
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopFixtureAgent(pid: number): Promise<void> {
  if (!processExists(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 3_000 });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already closed */ } }
  }
  const deadline = Date.now() + 3_000;
  while (processExists(pid)) {
    if (Date.now() >= deadline) throw new Error("Fixture agent did not stop before cleanup.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function readBootstrapUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let output = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for fixture Hub startup.")); }, 10_000);
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16_384);
      const match = output.match(/https?:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_%~-]+/);
      if (match) { cleanup(); resolveUrl(match[0]); }
    };
    const onExit = () => { cleanup(); reject(new Error(`Fixture Hub exited before startup.\n${output}`)); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      child.stdout?.resume();
      child.stderr?.resume();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopHub(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (!await waitForExit(child, 5_000)) {
    child.kill("SIGKILL");
    if (!await waitForExit(child, 3_000)) throw new Error("Fixture Hub did not stop before cleanup.");
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const onExit = () => { clearTimeout(timer); resolveExit(true); };
    const timer = setTimeout(() => { child.off("exit", onExit); resolveExit(false); }, timeoutMs);
    child.once("exit", onExit);
  });
}
