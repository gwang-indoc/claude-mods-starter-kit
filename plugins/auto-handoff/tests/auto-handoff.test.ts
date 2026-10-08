import { describe, expect, mock, test } from "claude-code/testing";
import { carriedHandoff, ensureIgnored, ignoresHandoff, parseCheckpoint, splitReply, timestamp, writeHandoff } from "../hooks/auto-handoff.mjs";

const CWD = "/work/demo";
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, view: {} };
const MSGS = [{ role: "user", text: "hi", toolUses: [] }] as any;
const START = new Date(2026, 9, 1, 9, 5, 7).getTime();

// An in-memory file system beneath the plugin, plus the engine answers it needs.
function world(
  on: any,
  files: Record<string, string> = {},
  mtimes: Record<string, number> = {},
  startedAt = 9e15,
) {
  const fs = new Map<string, string>(Object.entries(files));
  const seen = {
    failNext: false, forks: 0, checks: 0, verdict: "CHECKPOINT: yes - research done, coding next",
    percent: 20, compactions: [] as any[], appends: [] as any[], gate: null as Promise<void> | null, toasts: [] as string[], logs: [] as string[], prompts: [] as string[],
  };
  on("session.start", ($: any, e: any) => ({ cwd: e.cwd }));
  on("command.register", ($: any, e: any) => ({ value: { command: e.name } }));
  on("fs.exists", ($: any, e: any) => ({
    value: fs.has(e.path) || [...fs.keys()].some((k) => k.startsWith(e.path + "/")),
  }));
  on("fs.read", ($: any, e: any) => {
    if (!fs.has(e.path)) throw new Error(`ENOENT ${e.path}`);
    return { value: fs.get(e.path) };
  });
  on("fs.write", ($: any, e: any) => {
    fs.set(e.path, e.text);
    return { value: undefined };
  });
  on("fs.stat", ($: any, e: any) => ({
    value: { kind: "file", size: (fs.get(e.path) ?? "").length, mtimeMs: mtimes[e.path] ?? 0, isLink: false },
  }));
  on("model.fork", async ($: any, e: any) => {
    if (e.prompt.startsWith("Decide whether this session is at a natural checkpoint")) {
      seen.checks += 1;
      return { value: { isAnswered: true, text: seen.verdict } };
    }
    seen.forks += 1;
    const gate = seen.gate;
    seen.gate = null;
    if (gate) await gate;
    if (seen.failNext) { seen.failNext = false; return {value:{isAnswered:false,reason:"test failure"}}; }
    return {
      value: {
        isAnswered: true,
        text: "LATEST: Built the demo widget, tests pass.\n\n## 1. Session intent\nBuild the demo.\n",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };
  });
  on("ui.toast", ($: any, e: any) => {
    seen.toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.log", ($: any, e: any) => {
    seen.logs.push(e.text);
    return { value: undefined };
  });
  on("prompt.submit", ($: any, e: any) => {
    seen.prompts.push(e.text);
    return { text: e.text };
  });
  on("session.usage", () => ({
    value: { startedAt, context: { tokens: seen.percent * 2000, window: 200_000, percent: seen.percent }, rateLimits: [], cost: { usd: 0 } },
  }));
  on("session.compact", ($: any, e: any) => {
    seen.compactions.push(e);
    return { messages: [{ role: "assistant", text: "Summary of the session.", toolUses: [] }] };
  });
  on("session.append", ($: any, e: any, next: any) => {
    seen.appends.push(e);
    return next(e);
  });
  on("turn.start", () => ({ turnId: "t" }));

  on("tool.call", () => ({ result: "ok", text: "ok" }));
  on("session.measure", ($: any, e: any) => ({ changed: e.changed }));
  on("turn.complete", () => ({ text: "" }));
  on("ui.render", ($: any, e: any) => $.ui.resolve(e).Box({ children: [] }));
  return { fs, seen };
}

const measure = (percent: number) =>
  ({ context: { tokens: percent * 2000, window: 200_000, percent }, rateLimits: [], changed: ["context"] }) as any;
const run = (args: string) =>
  ({ command: "autohandoff", args, origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 120 } }) as any;
const firstOf = (text?: string) => (text ?? "").split("\n")[0];
const handoffs = (fs: Map<string, string>) =>
  [...fs.keys()].filter((k) => /\/handoff\/handoff-.*\.md$/.test(k)).sort();

describe("auto-handoff", () => {
  test("crossing the threshold writes exactly one handoff, and re-arms below it", async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.store(on);
    const { fs, seen } = world(on, { [`${CWD}/.git/HEAD`]: "ref" });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);

    await $.session.measure(measure(50));
    await clock.settle();
    expect(seen.forks).toBe(0);

    await $.session.measure(measure(86));
    await clock.settle();
    expect(seen.forks).toBe(1);
    expect(handoffs(fs).length).toBe(1);

    await $.session.measure(measure(90));
    await $.session.measure(measure(95));
    await clock.settle();
    expect(seen.forks).toBe(1);

    // A compaction drops the fill; the next crossing writes again.
    await clock.advance(2000);
    await $.session.measure(measure(30));
    await $.session.measure(measure(87));
    await clock.settle();
    expect(seen.forks).toBe(2);
    expect(handoffs(fs).length).toBe(2);
    expect(seen.toasts[0]).toMatch(/^Handoff saved to handoff\/handoff-/);
  });

  test("filename, LATEST.md, ACTIVE_PROJECT.md and the new .gitignore", async ($, on) => {
    mock.clock(on, { now: START });
    mock.store(on);
    const { fs, seen } = world(on, { [`${CWD}/.git/HEAD`]: "ref" });
    await $.session.start({ surface: null, isInteractive: false, cwd: CWD } as any);

    const out = await $.command.run(run("now"));
    expect(out.text).toBe("Handoff saved to handoff/handoff-2026-10-01-090507.md");
    const file = fs.get(`${CWD}/handoff/handoff-2026-10-01-090507.md`) ?? "";
    expect(file).toMatch(/^# Handoff, demo, 2026-10-01 09:05:07/);
    expect(file).toContain("## 1. Session intent");
    expect(file).not.toContain("LATEST:");
    expect(fs.get(`${CWD}/handoff/LATEST.md`)).toBe(
      "handoff-2026-10-01-090507.md\nBuilt the demo widget, tests pass.\n",
    );
    expect(fs.get(`${CWD}/handoff/ACTIVE_PROJECT.md`)).toBe(
      ".\nhandoff-2026-10-01-090507.md\nBuilt the demo widget, tests pass.\n",
    );
    expect(fs.get(`${CWD}/.gitignore`)).toBe("handoff/\n");

    // Same second again: never overwrite, add a suffix.
    const again = await $.command.run(run("now"));
    expect(again.text).toBe("Handoff saved to handoff/handoff-2026-10-01-090507-2.md");
    expect(seen.logs.some((l) => l.includes("saved handoff/handoff-2026-10-01-090507.md"))).toBe(true);
  });

  test("leaves a nested ACTIVE_PROJECT.md pointer alone", async ($, on) => {
    mock.clock(on, { now: START });
    mock.store(on);
    const { fs } = world(on, { [`${CWD}/handoff/ACTIVE_PROJECT.md`]: "apps/web\nhandoff-x.md\nweb work\n" });
    await $.session.start({ surface: null, isInteractive: false, cwd: CWD } as any);
    await $.command.run(run("now"));
    expect(fs.get(`${CWD}/handoff/ACTIVE_PROJECT.md`)).toBe("apps/web\nhandoff-x.md\nweb work\n");
  });

  test("gitignore handling", async () => {
    const make = (files: Record<string, string>) => {
      const fs = new Map(Object.entries(files));
      const io = {
        exists: async (p: string) => fs.has(p),
        read: async (p: string) => fs.get(p) ?? "",
        write: async (p: string, t: string) => void fs.set(p, t),
      };
      return { fs, io };
    };
    const a = make({ "/r/.gitignore": "node_modules" });
    expect(await ensureIgnored(a.io, "/r")).toBe("added handoff/ to .gitignore");
    expect(a.fs.get("/r/.gitignore")).toBe("node_modules\nhandoff/\n");

    const b = make({ "/r/.gitignore": "dist/\n/handoff\n" });
    expect(await ensureIgnored(b.io, "/r")).toBe("");
    expect(b.fs.get("/r/.gitignore")).toBe("dist/\n/handoff\n");

    const c = make({ "/r/.git": "" });
    expect(await ensureIgnored(c.io, "/r")).toBe("created .gitignore with handoff/");
    expect(c.fs.get("/r/.gitignore")).toBe("handoff/\n");

    const d = make({});
    expect(await ensureIgnored(d.io, "/r")).toBe("");
    expect(d.fs.has("/r/.gitignore")).toBe(false);

    expect(ignoresHandoff("handoff/")).toBe(true);
    expect(ignoresHandoff("handoffs/\nmy-handoff/")).toBe(false);
  });

  test("timestamp and reply parsing", async () => {
    expect(timestamp(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe("2026-01-02-030405");
    expect(splitReply("LATEST: Done.\n\n## 1. x").summary).toBe("Done.");
    expect(splitReply("## 1. x").summary).toBe("Auto handoff written by auto-handoff.");
  });

  test("commands: status, threshold, off and on", async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.store(on);
    const { seen } = world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);

    let out = await $.command.run(run(""));
    expect(out.text).toMatch(/Auto handoff is on, context fill 20%/);
    expect(out.text).toMatch(/checkpoint from 70% \(checked every 1%\).*hard threshold 85%/);
    expect(out.text).toMatch(/No handoff written this session/);

    out = await $.command.run(run("threshold 40"));
    expect(out.text).toBe("Hard threshold set to 40%.");
    out = await $.command.run(run("threshold abc"));
    expect(out.text).toMatch(/Usage/);

    out = await $.command.run(run("off"));
    expect(out.text).toBe("Auto handoff is off.");
    await $.session.measure(measure(50));
    await clock.settle();
    expect(seen.forks).toBe(0);

    await $.command.run(run("on"));
    await $.session.measure(measure(51));
    await clock.settle();
    expect(seen.forks).toBe(1);

    out = await $.command.run(run(""));
    expect(out.text).toMatch(/hard threshold 40%/);
    expect(out.text).toMatch(/Last handoff handoff\/handoff-2026-10-01-090507\.md, just now/);
  });

  test("the userConfig threshold is the default", { options: { threshold: 60 } }, async ($, on) => {
    mock.clock(on, { now: START });
    mock.store(on);
    world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);
    const out = await $.command.run(run(""));
    expect(out.text).toMatch(/threshold 60%/);
  });

  test("writes a new handoff before every compaction", async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.store(on);
    const { fs, seen } = world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);

    await $.session.compact({ trigger: "auto", messages: MSGS } as any);
    expect(seen.forks).toBe(1);
    expect(handoffs(fs).length).toBe(1);

    await clock.advance(60_000);
    await $.session.compact({ trigger: "precompute", messages: MSGS } as any);
    expect(seen.forks).toBe(1);

    await $.session.compact({ trigger: "manual", messages: MSGS } as any);
    expect(seen.forks).toBe(2);

    // A handoff written moments before is not reused: the compaction writes
    // its own, so nothing said since is missing.
    await clock.advance(60_000);
    await $.command.run(run("now"));
    await clock.settle();
    expect(seen.forks).toBe(3);
    await clock.advance(1000);
    await $.session.compact({ trigger: "auto", messages: MSGS } as any);
    expect(seen.forks).toBe(4);
    expect(handoffs(fs).length).toBe(4);
  });

  test("the resume band shows, yields to a survey, and goes after resume", async ($, on) => {
    const now = START + 2 * 3600_000;
    const clock = mock.clock(on, { now });
    mock.store(on);
    const latest = `${CWD}/handoff/LATEST.md`;
    const { seen } = world(on, { [latest]: "handoff-2026-10-01-090507.md\nBuilt it.\n", [`${CWD}/handoff/handoff-2026-10-01-090507.md`]: "# Handoff\nBuilt it." }, { [latest]: START });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);

    const quiet = await $.ui.mount({
      plugin: "auto-handoff", surface: "terminal", component: "AbovePrompt", props: { ...BAND, hasSurvey: true },
    } as any);
    expect(await quiet.find({ type: "Text", text: /Handoff from/ })).toBeUndefined();
    await quiet.unmount();

    const ui = await $.ui.mount({
      plugin: "auto-handoff", surface: "terminal", component: "AbovePrompt", props: BAND,
    } as any);
    expect(await ui.find({ type: "Text", text: "Handoff from 2 h ago available" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "/autohandoff resume" })).toBeDefined();

    const out = await $.command.run(run("resume"));
    expect(out.text).toBe("Resuming from handoff/LATEST.md");
    await clock.settle();
    expect(seen.prompts.length).toBe(1);
    expect(seen.prompts[0]).toMatch(/^Read handoff\/LATEST\.md/);
    expect(await ui.find({ type: "Text", text: /Handoff from/ })).toBeUndefined();
    await ui.unmount();
  });

  test("the resume band goes after the first turn", async ($, on) => {
    mock.clock(on, { now: START + 60_000 });
    mock.store(on);
    const latest = `${CWD}/handoff/LATEST.md`;
    world(on, { [latest]: "handoff-a.md\nx\n" }, { [latest]: START });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);
    const ui = await $.ui.mount({
      plugin: "auto-handoff", surface: "terminal", component: "AbovePrompt", props: BAND,
    } as any);
    expect(await ui.find({ type: "Text", text: "Handoff from 1 min ago available" })).toBeDefined();
    await $.turn.complete({ reason: "answer", answer: "hi", durationMs: 10, isAborted: false, turnId: "t1" } as any);
    expect(await ui.find({ type: "Text", text: /Handoff from/ })).toBeUndefined();
    await ui.unmount();
  });

  test("no band for a handoff this same session wrote", async ($, on) => {
    mock.clock(on, { now: START + 60_000 });
    mock.store(on);
    const latest = `${CWD}/handoff/LATEST.md`;
    world(on, { [latest]: "handoff-a.md\nx\n" }, { [latest]: START + 30_000 }, START);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);
    const ui = await $.ui.mount({
      plugin: "auto-handoff", surface: "terminal", component: "AbovePrompt", props: BAND,
    } as any);
    expect(await ui.find({ type: "Text", text: /Handoff from/ })).toBeUndefined();
    await ui.unmount();
  });

  test("no band without a LATEST.md", async ($, on) => {
    mock.clock(on, { now: START });
    mock.store(on);
    world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);
    const ui = await $.ui.mount({
      plugin: "auto-handoff", surface: "terminal", component: "AbovePrompt", props: BAND,
    } as any);
    expect(await ui.find({ type: "Text", text: /Handoff from/ })).toBeUndefined();
    const out = await $.command.run(run("resume"));
    expect(out.text).toMatch(/No handoff\/LATEST\.md/);
    await ui.unmount();
  });
});


test("resume refuses a missing referenced handoff without submitting a prompt", async ($, on) => {
 const clock=mock.clock(on,{now:START});mock.store(on);
 const {seen}=world(on,{[`${CWD}/handoff/LATEST.md`]:"gone.md\nold"});
 await $.session.start({surface:"desktop",isInteractive:true,cwd:CWD} as any);
 const result=await $.command.run(run("resume"));await clock.settle();
 expect(result.text).toContain("missing");expect(seen.prompts.length).toBe(0);
});

test("empty summaries preserve the previous handoff and announce failure", async () => {
 const writes:string[]=[];const toasts:string[]=[];let busy=false;
 const out=await writeHandoff({isBusy:async()=>busy,setBusy:async(v:boolean)=>{busy=v},now:async()=>START,fork:async()=>({isAnswered:true,text:""}),write:async(p:string)=>{writes.push(p)},log:()=>{},toast:(t:string)=>toasts.push(t)}, {cwd:CWD,reason:"test"});
 expect(out.skipped).toBe("error");expect(writes.length).toBe(0);expect(busy).toBe(false);expect(toasts[0]).toContain("not saved");
});

test("failed automatic save retries on the next context measurement", async ($, on) => {
 const clock=mock.clock(on,{now:START});mock.store(on);const {seen,fs}=world(on);
 await $.session.start({surface:"desktop",isInteractive:true,cwd:CWD} as any);
 seen.failNext=true;await $.session.measure(measure(86));await clock.settle();
 expect(handoffs(fs).length).toBe(0);
 await $.session.measure(measure(87));await clock.settle();
 expect(seen.forks).toBe(2);expect(handoffs(fs).length).toBe(1);
});

const turnEnd = (reason = "answer") =>
  ({ reason, answer: "done", durationMs: 10, isAborted: reason === "aborted", turnId: "t" }) as any;

describe("checkpoint switching", () => {
  test("past the soft threshold, a checkpoint compacts to a fresh context with a new handoff", async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.store(on);
    const { fs, seen } = world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);

    seen.percent = 50;
    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(0);

    seen.percent = 72;
    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(1);
    expect(seen.compactions.length).toBe(1);
    expect(seen.compactions[0].instructions).toMatch(/handoff document is appended/);
    expect(handoffs(fs).length).toBe(1);
    expect(seen.toasts.at(-1)).toMatch(/^Checkpoint at 72%: switched to a fresh context with handoff\/handoff-/);
    // This harness runs no hook of the calling plugin for its own compaction,
    // so the handoff goes in as a row appended after it.
    expect(seen.appends.length).toBe(1);
    expect(seen.appends[0].message.type).toBe("user");
    expect(seen.appends[0].message.content[0].text).toMatch(/^\[auto-handoff\] The conversation was just compacted/);

    const out = await $.command.run(run(""));
    expect(out.text).toMatch(/Last checkpoint switch just now, at 72%/);
  });

  test("no checkpoint means no switch, and the next check waits for the step", async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.store(on);
    const { seen } = world(on);
    seen.verdict = "CHECKPOINT: no - edits to the parser are half done";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);

    seen.percent = 72;
    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(1);
    expect(seen.compactions.length).toBe(0);
    expect(seen.forks).toBe(0);
    expect(seen.logs.some((l) => l === "checkpoint check at 72%: no (edits to the parser are half done)")).toBe(true);

    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(1);

    seen.percent = 73;
    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(2);

    expect((await $.command.run(run("step 3"))).text).toBe("Checkpoint checks every 3% past the soft threshold.");
    seen.percent = 75;
    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(2);
    seen.percent = 76;
    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(3);
  });

  test("the free pre-filter skips the model mid-edit, mid-todo, mid-task and after an interrupt", async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.store(on);
    const { seen } = world(on);
    seen.verdict = "CHECKPOINT: no - not yet";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);
    seen.percent = 75;

    // An edit with nothing run after it.
    await $.turn.start({ turnId: "t" } as any);
    await $.tool.call({ tool: "Edit", file_path: "/w/a.ts", old_string: "a", new_string: "b" } as any);
    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(0);

    // A todo still in progress.
    await $.turn.start({ turnId: "t" } as any);
    await $.tool.call({ tool: "TodoWrite", todos: [{ content: "x", status: "in_progress", activeForm: "x" }] } as any);
    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(0);
    await $.turn.start({ turnId: "t" } as any);
    await $.tool.call({ tool: "TodoWrite", todos: [{ content: "x", status: "completed", activeForm: "x" }] } as any);

    // A task still in progress.
    await $.tool.call({ tool: "TaskUpdate", taskId: "7", status: "in_progress" } as any);
    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(0);
    await $.turn.start({ turnId: "t" } as any);
    await $.tool.call({ tool: "TaskUpdate", taskId: "7", status: "completed" } as any);

    // An interrupted turn.
    await $.turn.complete(turnEnd("aborted"));
    await clock.settle();
    expect(seen.checks).toBe(0);

    // An edit followed by a command run passes to the model.
    await $.turn.start({ turnId: "t" } as any);
    await $.tool.call({ tool: "Edit", file_path: "/w/a.ts", old_string: "b", new_string: "c" } as any);
    await $.tool.call({ tool: "Bash", command: "npm test" } as any);
    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(1);
  });

  test("a checkpoint found while a new turn runs waits for that turn to end", async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.store(on);
    const { seen } = world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);
    seen.percent = 72;
    await $.turn.complete(turnEnd());
    await $.turn.start({ turnId: "t" } as any);
    await clock.settle();
    expect(seen.checks).toBe(1);
    expect(seen.compactions.length).toBe(0);

    // Checked again at the same fill, whatever the step.
    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(2);
    expect(seen.compactions.length).toBe(1);
  });

  test("switch off, auto handoff off, and non-interactive sessions never switch", async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.store(on);
    const { seen } = world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);
    seen.percent = 80;

    expect((await $.command.run(run("switch off"))).text).toBe("Checkpoint switching is off.");
    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(0);
    expect((await $.command.run(run(""))).text).toMatch(/checkpoint switching off/);

    await $.command.run(run("switch on"));
    await $.command.run(run("off"));
    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(0);

    await $.command.run(run("on"));
    await $.session.start({ surface: null, isInteractive: false, cwd: CWD } as any);
    await $.turn.complete(turnEnd());
    await clock.settle();
    expect(seen.checks).toBe(0);
  });

  test("soft and hard commands", async ($, on) => {
    mock.clock(on, { now: START });
    mock.store(on);
    world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);
    expect((await $.command.run(run("soft 60"))).text).toBe("Soft threshold set to 60%.");
    expect((await $.command.run(run("hard 90"))).text).toBe("Hard threshold set to 90%.");
    expect((await $.command.run(run("soft 0"))).text).toMatch(/Usage/);
    expect((await $.command.run(run("step 50"))).text).toMatch(/Usage/);
    expect((await $.command.run(run("switch maybe"))).text).toMatch(/Usage/);
    const out = await $.command.run(run(""));
    expect(out.text).toMatch(/checkpoint from 60%.*hard threshold 90%/);
  });

  test("userConfig sets the soft threshold, step and switching defaults", { options: { softThreshold: 50, step: 4, autoSwitch: false } }, async ($, on) => {
    mock.clock(on, { now: START });
    mock.store(on);
    world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);
    await $.command.run(run("switch on"));
    const out = await $.command.run(run(""));
    expect(out.text).toMatch(/checkpoint from 50% \(checked every 4%\)/);
  });
});

describe("handoff carried into compaction", () => {
  test("follows the engine summary and points at the transcript", async ($, on) => {
    mock.clock(on, { now: START });
    mock.store(on);
    const { seen } = world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);

    const first = await $.session.compact({ trigger: "auto", messages: MSGS } as any);
    expect(seen.forks).toBe(1);
    expect(first.messages?.length).toBe(2);
    expect(first.messages?.[0].text).toBe("Summary of the session.");
    const carried = first.messages?.[1];
    expect(carried?.role).toBe("user");
    expect(carried?.text).toMatch(/^\[auto-handoff\] The conversation was just compacted/);
    expect(carried?.text).toContain("handoff/handoff-2026-10-01-090507.md");
    expect(carried?.text).toContain("full transcript file the summary names");
    expect(carried?.text).toContain("## 1. Session intent");
  });

  test("a compaction during a slower handoff write writes its own, which keeps LATEST.md", async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.store(on);
    let release = () => {};
    const { fs, seen } = world(on);
    seen.gate = new Promise<void>((r) => (release = r));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);

    await $.command.run(run("now"));
    await clock.settle();
    await clock.advance(5000);
    const out = await $.session.compact({ trigger: "auto", messages: MSGS } as any);
    expect(seen.forks).toBe(2);
    expect(out.messages?.[1].text).toContain("handoff/handoff-2026-10-01-090512.md");

    // The slower write, forked earlier, ends last: its file is kept, LATEST.md is not moved.
    release();
    await clock.settle();
    expect(handoffs(fs)).toEqual([
      `${CWD}/handoff/handoff-2026-10-01-090512-2.md`,
      `${CWD}/handoff/handoff-2026-10-01-090512.md`,
    ]);
    expect(firstOf(fs.get(`${CWD}/handoff/LATEST.md`))).toBe("handoff-2026-10-01-090512.md");
    expect(seen.logs.some((l) => /handoff-2026-10-01-090512-2\.md \(a newer handoff keeps LATEST\.md\)/.test(l))).toBe(true);
    expect((await $.command.run(run(""))).text).toMatch(/Last handoff handoff\/handoff-2026-10-01-090512\.md/);
  });

  test("nothing is carried when auto handoffs are off or no handoff could be written", async ($, on) => {
    const clock = mock.clock(on, { now: START });
    mock.store(on);
    const { seen } = world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: CWD } as any);

    await $.command.run(run("off"));
    const off = await $.session.compact({ trigger: "auto", messages: MSGS } as any);
    expect(off.messages?.length).toBe(1);
    expect(seen.forks).toBe(0);

    // An older handoff is never carried in when the new one fails.
    await $.command.run(run("on"));
    await $.command.run(run("now"));
    await clock.settle();
    expect(seen.forks).toBe(1);
    seen.failNext = true;
    const failed = await $.session.compact({ trigger: "auto", messages: MSGS } as any);
    expect(seen.forks).toBe(2);
    expect(failed.messages?.length).toBe(1);
  });

  test("carriedHandoff and parseCheckpoint", async () => {
    expect(carriedHandoff("handoff/h.md", "# H\n")).toBe(
      "[auto-handoff] The conversation was just compacted. Below is the handoff written right before it (handoff/h.md). For decisions, current state and next steps, treat this handoff as authoritative and the summary above as background. If a detail is missing from both, search the full transcript file the summary names with grep for that detail; never read it whole.\n\n# H\n",
    );
    expect(parseCheckpoint({ isAnswered: true, text: "CHECKPOINT: yes - bug fixed and verified" } as any))
      .toEqual({ isCheckpoint: true, why: "bug fixed and verified" });
    expect(parseCheckpoint({ isAnswered: true, text: "checkpoint: NO" } as any).isCheckpoint).toBe(false);
    expect(parseCheckpoint({ isAnswered: true, text: "Probably yes" } as any))
      .toEqual({ isCheckpoint: false, why: "unreadable verdict" });
    expect(parseCheckpoint({ isAnswered: false, reason: "api-error" } as any).isCheckpoint).toBe(false);
  });
});
