// Auto Handoff: writes a cold-start handoff to <project>/handoff/, switches to
// a fresh context at a natural checkpoint past the soft threshold, carries the
// handoff into every compaction, and offers to resume from it next session.

const CWD = { plugin: "auto-handoff", key: "cwd" };
const INTERACTIVE = { plugin: "auto-handoff", key: "isInteractive" };
const FIRED = { plugin: "auto-handoff", key: "fired" };
const BUSY = { plugin: "auto-handoff", key: "busy" };
const LAST = { plugin: "auto-handoff", key: "last" };
const OFFER = { plugin: "auto-handoff", key: "offer" };
const RUNNING = { plugin: "auto-handoff", key: "isTurnRunning" };
const EDIT_OPEN = { plugin: "auto-handoff", key: "isEditOpen" };
const TODO_ACTIVE = { plugin: "auto-handoff", key: "isTodoActive" };
const ACTIVE_TASKS = { plugin: "auto-handoff", key: "activeTasks" };
const CHECKING = { plugin: "auto-handoff", key: "isChecking" };
const LAST_CHECK = { plugin: "auto-handoff", key: "lastCheck" };
const SWITCHED = { plugin: "auto-handoff", key: "switched" };
const CARRIED = { plugin: "auto-handoff", key: "isCarried" };
const PREPARED = { plugin: "auto-handoff", key: "prepared" };
const LATEST_START = { plugin: "auto-handoff", key: "latestStart" };
const COMPACTED_AT = { plugin: "auto-handoff", key: "compactedAt" };
const VERDICT = { plugin: "auto-handoff", key: "lastVerdict" };
const SIGNAL_AGE = { plugin: "auto-handoff", key: "signalAge" };
const CHECKS_USED = { plugin: "auto-handoff", key: "checksUsed" };

const DEFAULT_HARD = 85;
const DEFAULT_SOFT = 70;
const DEFAULT_STEP = 1;
// Checks per compaction cycle: at 1% steps, 70% to 85% and no further.
const MAX_CHECKS = 15;
// Main turns a todo or task may sit in progress before it stops holding
// checks back (a model that never marks one done would block switching).
const STALE_TURNS = 10;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export const HANDOFF_PROMPT = `Write a cold-start handoff for this session, so a new agent with no access to this conversation can pick up the work exactly where it stands. Do not call any tools. Answer with the document only.

Line 1 must be exactly "LATEST: " followed by one sentence on where the session landed. Then a blank line, then the handoff in markdown with these sections, each as a "##" heading:

## 1. Session intent
The goal and what the user actually wanted.
## 2. The back-and-forth
The meaningful requests, responses and pivots, in order, and why they happened.
## 3. Tools and skills used
Each material tool or skill used and what it accomplished.
## 4. Research, data, and sources
Outside information brought in and the findings that shaped decisions. "None" if none.
## 5. Iterations and generations
Versions, generated assets and what changed each pass. "None" if none.
## 6. Decisions locked
Settled decisions and why each was made. List unresolved decisions separately.
## 7. Current state
What is done, in progress or blocked. Say plainly what was verified (tests run, output seen) and what was not.
## 8. Asset map
Every file created, changed or important to the work, with its path and what it is for.
## 9. Open threads and next steps
Open questions, then the exact next steps in order, with the commands to run where they matter.
## 10. For the next agent
What to read first and the traps a cold start is likely to hit.

Rules: use only facts from this conversation and mark anything assumed. Include exact paths, commands, branch names, ports and test results when they matter. Never include passwords, API keys, tokens or other secrets. Do not use em dashes.`;

export const CHECKPOINT_PROMPT = `Decide whether this session is at a natural checkpoint, a good moment to swap this conversation for a fresh context that starts from a written handoff. Do not call any tools.

A checkpoint: a research or exploration phase just finished and coding has not started; a bug was just fixed and verified; a task is finished and the next has not begun; the assistant is waiting for the user to choose a new direction.
Not a checkpoint: code edits are partly done, a fix is not yet verified, a multi-step change or plan is mid-way, or the user is in the middle of explaining something.

Answer with exactly one line: "CHECKPOINT: yes" or "CHECKPOINT: no", then " - " and a reason of at most 12 words.`;

const SWITCH_INSTRUCTIONS =
  "A detailed handoff document is appended right after this summary, so keep the summary short and focus on conversational detail the handoff may miss.";

export const RESUME_PROMPT =
  "Read handoff/LATEST.md, then the handoff file named on its first line (in handoff/). Brief me in a few lines on where we left off, verify the current state of anything it calls done, then continue with the next steps it lists. Where it says a step waits for my go-ahead, ask instead of doing it.";

export function register(on, options) {
  const fallback = {
    threshold: toPercent(options?.threshold) ?? DEFAULT_HARD,
    soft: toPercent(options?.softThreshold) ?? DEFAULT_SOFT,
    step: toStep(options?.step) ?? DEFAULT_STEP,
    isEnabled: options?.enabled !== false,
    isSwitching: options?.autoSwitch !== false,
  };

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await $.command.register({
      name: "autohandoff",
      description: "Auto handoff status, or now | resume | soft <n> | hard <n> | step <n> | switch on|off | on | off",
      argumentHint: "[now|resume|soft <n>|hard <n>|step <n>|switch on|off|on|off]",
    });
    await $.state.set(CWD, e.cwd);
    await $.state.set(INTERACTIVE, e.isInteractive);
    // A reload cuts a check short and starts between turns.
    await $.state.set(CHECKING, false);
    await $.state.set(RUNNING, false);
    // Offer a handoff from an earlier session only: this hook runs again when
    // the module reloads, and one written since the session began is its own.
    const latest = `${e.cwd}/handoff/LATEST.md`;
    if (await $.fs.exists(latest)) {
      const text = await $.fs.read(latest).catch(() => "");
      const stat = await $.fs.stat(latest).catch(() => undefined);
      const { startedAt } = await $.session.usage();
      const file = firstLine(text);
      const at = stat?.mtimeMs ?? 0;
      const isEarlier = !(startedAt > 0) || at < startedAt;
      if (file && isEarlier) await $.state.set(OFFER, { at, file });
    }
    return result;
  });

  on("turn.start", async ($, e, next) => {
    await $.state.set(RUNNING, true);
    await $.state.set(EDIT_OPEN, false);
    return next(e);
  });

  // Free signals for the checkpoint pre-filter: an edit with no command run
  // after it (a read-only one like ls does not count), or a todo or task
  // still in progress, means work is mid-way.
  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId || result?.deny || result?.isError) return result;
    if (EDIT_TOOLS.has(e.tool)) {
      await $.state.set(EDIT_OPEN, true);
    } else if (e.tool === "Bash" && !result?.isReadOnly) {
      await $.state.set(EDIT_OPEN, false);
    } else if (e.tool === "TodoWrite") {
      await $.state.set(TODO_ACTIVE, (e.todos ?? []).some((t) => t.status === "in_progress"));
      await $.state.set(SIGNAL_AGE, 0);
    } else if (e.tool === "TaskUpdate" && e.status) {
      const { value: tasks = [] } = await $.state.get(ACTIVE_TASKS);
      const rest = tasks.filter((id) => id !== e.taskId);
      await $.state.set(ACTIVE_TASKS, e.status === "in_progress" ? [...rest, e.taskId] : rest);
      await $.state.set(SIGNAL_AGE, 0);
    }
    return result;
  }).catch(($, e, next) => next(e));

  // The resume offer goes once the first main-thread turn is done; past the
  // soft threshold, each main-thread turn's end looks for a checkpoint.
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId) return result;
    await $.state.set(RUNNING, false);
    const { value: offer = null } = await $.state.get(OFFER);
    if (offer) await $.state.set(OFFER, null);
    const { value: age = 0 } = await $.state.get(SIGNAL_AGE);
    await $.state.set(SIGNAL_AGE, age + 1);
    if (age + 1 === STALE_TURNS && (await isWorkSignalled($))) {
      $.ui.log(`a todo or task has been in progress for ${STALE_TURNS} turns without a change; it no longer holds checkpoint checks back`);
    }
    const reason = e.reason;
    $.clock.after(0, () => {
      void checkpoint($, reason, fallback).catch((err) => {
        $.ui.log(`checkpoint check failed (${err?.message ?? err})`);
      });
    });
    return result;
  });

  // Pushed after each main-thread turn: past the hard threshold, write one
  // handoff in the background without switching (work may be mid-way); below
  // it again (a compaction), arm for the next crossing.
  on("session.measure", async ($, e, next) => {
    const result = await next(e);
    if (!e.changed.includes("context")) return result;
    const percent = e.context?.percent;
    if (percent === undefined) return result;
    const settings = await settingsOf($, fallback);
    const { value: fired = false } = await $.state.get(FIRED);
    if (percent < settings.threshold) {
      if (fired) await $.state.set(FIRED, false);
      return result;
    }
    if (fired || !settings.isEnabled) return result;
    if ((await $.state.get(BUSY)).value) return result;
    await $.state.set(FIRED, true);
    const { value: cwd = "" } = await $.state.get(CWD);
    const reason = `context at ${percent}%, hard threshold ${settings.threshold}%`;
    $.ui.log(`${reason}, writing a handoff in the background`);
    $.clock.after(0, () => {
      void writeHandoff(ioFor($), { cwd, reason }).then((saved) => {
        if (!saved.path) return $.state.set(FIRED, false);
      });
    });
    return result;
  });

  // Every compaction of the main conversation (auto, /compact, a checkpoint
  // switch): write a new handoff (a switch brings the one it just wrote), let
  // the engine compact, then put the handoff after the engine's summary. When
  // the new one cannot be written (the fork can fail on a full context), the
  // latest one since the last compaction goes in instead, marked with its age.
  on("session.compact", async ($, e, next) => {
    if (e.trigger === "precompute" || !!e.agentId) return next(e);
    const settings = await settingsOf($, fallback);
    let handoff = null;
    if (settings.isEnabled) {
      const { value: prepared = null } = await $.state.get(PREPARED);
      handoff = prepared ?? (await handoffForCompaction($, e.trigger)) ?? (await earlierHandoff($));
    } else {
      $.ui.log("compaction without a handoff, auto handoffs are off");
    }
    const result = await next(e);
    if (result?.skip) return result;
    await markCompacted($);
    if (!handoff || !result?.messages) return result;
    const text = await carriedText($, handoff);
    if (!text) return result;
    await $.state.set(CARRIED, true);
    return { ...result, messages: [...result.messages, { role: "user", text, toolUses: [] }] };
  }).catch(($, e, next) => next(e));

  on("command.run", { command: "autohandoff" }, async ($, e) => {
    const [verb = "", value = ""] = (e.args ?? "").trim().split(/\s+/);
    const stored = await $.store.get("settings");
    const settings = readSettings(stored, fallback);
    const { value: cwd = "" } = await $.state.get(CWD);
    const save = (patch) => $.store.set("settings", { ...asObject(stored), ...patch });

    if (verb === "" || verb === "status") {
      const { value: last = null } = await $.state.get(LAST);
      const { value: switched = null } = await $.state.get(SWITCHED);
      const usage = await $.session.usage();
      const now = await $.clock.now();
      let lastLine = "No handoff written this session.";
      if (last) {
        lastLine = `Last handoff ${last.path}, ${ago(now - last.at)} (${last.reason}).`;
      } else if (cwd && (await $.fs.exists(`${cwd}/handoff/LATEST.md`))) {
        const file = firstLine(await $.fs.read(`${cwd}/handoff/LATEST.md`).catch(() => ""));
        const stat = await $.fs.stat(`${cwd}/handoff/LATEST.md`).catch(() => undefined);
        if (file) lastLine = `No handoff this session. Latest on disk is handoff/${file}, ${ago(now - (stat?.mtimeMs ?? now))}.`;
      }
      const switchLine = switched ? `Last checkpoint switch ${ago(now - switched.at)}, at ${switched.percent}%.` : "";
      const { value: verdict = null } = await $.state.get(VERDICT);
      const { value: used = 0 } = await $.state.get(CHECKS_USED);
      const checkLine = [
        verdict ? `Last check at ${verdict.percent}%: ${verdict.text}.` : "",
        used > 0 ? `${used} of ${MAX_CHECKS} checks used since the last compaction.` : "",
      ].filter(Boolean).join(" ");
      return { text: statusText(settings, usage.context?.percent, lastLine, switchLine, checkLine) };
    }

    if (verb === "on" || verb === "off") {
      await save({ isEnabled: verb === "on" });
      return { text: `Auto handoff is ${verb}.` };
    }

    if (verb === "switch") {
      if (value !== "on" && value !== "off") return { text: "Usage is /autohandoff switch on|off" };
      await save({ isSwitching: value === "on" });
      return { text: `Checkpoint switching is ${value}.` };
    }

    if (verb === "threshold" || verb === "hard") {
      const n = toPercent(value);
      if (n === undefined) return { text: `Usage is /autohandoff ${verb} <1-99>` };
      await save({ threshold: n });
      await $.state.set(FIRED, false);
      return { text: `Hard threshold set to ${n}%.` };
    }

    if (verb === "soft") {
      const n = toPercent(value);
      if (n === undefined) return { text: "Usage is /autohandoff soft <1-99>" };
      await save({ soft: n });
      await $.state.set(LAST_CHECK, null);
      return { text: `Soft threshold set to ${n}%.` };
    }

    if (verb === "step") {
      const n = toStep(value);
      if (n === undefined) return { text: "Usage is /autohandoff step <1-20>" };
      await save({ step: n });
      return { text: `Checkpoint checks every ${n}% past the soft threshold.` };
    }

    if (verb === "resume") {
      if (!cwd || !(await $.fs.exists(`${cwd}/handoff/LATEST.md`))) {
        return { text: "No handoff/LATEST.md in this folder to resume from." };
      }
      const pointer = firstLine(await $.fs.read(`${cwd}/handoff/LATEST.md`).catch(() => ""));
      if (!pointer || pointer.includes("/") || pointer.includes("\\") || !pointer.endsWith(".md") || !(await $.fs.exists(`${cwd}/handoff/${pointer}`))) {
        return { text: "The latest handoff file is missing or the pointer is invalid. Run /autohandoff now in the original conversation and wait for the saved confirmation." };
      }
      await $.state.set(OFFER, null);
      // A command.run hook may not submit (the prompt would wait on this very
      // hook), so the prompt goes from a timer once the command has answered.
      $.clock.after(0, () => {
        void $.prompt.submit({ text: RESUME_PROMPT });
      });
      return { text: "Resuming from handoff/LATEST.md" };
    }

    if (verb === "now") {
      if ((await $.state.get(BUSY)).value) return { text: "A handoff is already being written." };
      const { value: isInteractive = false } = await $.state.get(INTERACTIVE);
      const io = ioFor($);
      if (isInteractive) {
        $.clock.after(0, () => {
          void writeHandoff(io, { cwd, reason: "/autohandoff now" });
        });
        return { text: "Writing a handoff in the background. A toast says when it is saved." };
      }
      const saved = await writeHandoff(io, { cwd, reason: "/autohandoff now" });
      return { text: saved.path ? `Handoff saved to ${saved.path}` : `No handoff written (${saved.skipped}).` };
    }

    return { text: "Usage is /autohandoff [now|resume|soft <n>|hard <n>|step <n>|switch on|off|on|off]" };
  });

  // The resume offer, stacked under whatever other mods draw in the band.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const original = await next(e);
    if (e.props.hasSurvey || e.props.view?.agentId) return original;
    const { value: offer = null } = await $.state.get(OFFER);
    if (!offer) return original;
    const now = await $.clock.now();
    const { Box, Text } = $.ui.resolve(e);
    const mine = Box({
      flexDirection: "row",
      paddingX: 1,
      children: [
        Text({ color: "cyan", bold: true, children: "↺ " }),
        Text({ children: `Handoff from ${ago(now - offer.at)} available` }),
        Text({ dimColor: true, children: " · " }),
        Text({ bold: true, children: "/autohandoff resume" }),
      ],
    });
    if (!original) return mine;
    return Box({ flexDirection: "column", children: [original, mine] });
  });
}

async function checkpoint($, reason, fallback) {
  const settings = await settingsOf($, fallback);
  if (!settings.isEnabled || !settings.isSwitching) return;
  if (!(await $.state.get(INTERACTIVE)).value) return;
  const percent = (await $.session.usage()).context?.percent;
  if (percent === undefined || percent < settings.soft) return;
  let { value: lastCheck = null } = await $.state.get(LAST_CHECK);
  if (lastCheck !== null && percent < lastCheck) lastCheck = null;
  if (lastCheck !== null && percent - lastCheck < settings.step) return;
  const { value: used = 0 } = await $.state.get(CHECKS_USED);
  if (used >= MAX_CHECKS) return;
  const held = await heldBack($, reason);
  if (held) {
    await $.state.set(VERDICT, { percent, text: `held back, ${held}` });
    return;
  }
  if ((await $.state.get(BUSY)).value || (await $.state.get(CHECKING)).value) return;

  await $.state.set(CHECKING, true);
  try {
    await $.state.set(LAST_CHECK, percent);
    await $.state.set(CHECKS_USED, used + 1);
    if (used + 1 === MAX_CHECKS) $.ui.log(`all ${MAX_CHECKS} checkpoint checks for this cycle are used; the next compaction starts a new cycle`);
    const reply = await $.model.fork({ prompt: CHECKPOINT_PROMPT });
    const verdict = parseCheckpoint(reply);
    const text = `${verdict.isCheckpoint ? "yes" : "no"} (${verdict.why})`;
    await $.state.set(VERDICT, { percent, text });
    $.ui.log(`checkpoint check at ${percent}%: ${text}`);
    if (!verdict.isCheckpoint) return;
    await switchContext($, percent);
  } finally {
    await $.state.set(CHECKING, false);
  }
}

// Writes the handoff, then compacts the conversation. The session.compact
// hook carries that same handoff in when it runs for this plugin's own call;
// when it did not, the handoff is appended after the compaction instead. A
// turn already running puts the switch off: the next turn's end checks again,
// whatever the step.
async function switchContext($, percent) {
  if ((await $.state.get(RUNNING)).value) {
    await $.state.set(LAST_CHECK, null);
    $.ui.log("checkpoint found, but a turn is running; checking again when it ends");
    return;
  }
  const { value: cwd = "" } = await $.state.get(CWD);
  const saved = await writeHandoff(ioFor($), { cwd, reason: "checkpoint switch" });
  if (!saved.path) {
    $.ui.log("checkpoint found, but no handoff could be written; not switching");
    return;
  }
  const handoff = { path: saved.path };
  await $.state.set(PREPARED, handoff);
  await $.state.set(CARRIED, false);
  let done;
  try {
    done = await $.session.compact({ instructions: SWITCH_INSTRUCTIONS });
  } catch (err) {
    await $.state.set(LAST_CHECK, null);
    $.ui.log(`switch put off (${err?.message ?? err}); checking again when the next turn ends`);
    return;
  } finally {
    await $.state.set(PREPARED, null);
  }
  if (done?.skip) {
    $.ui.log(`switch skipped (${done.skip})`);
    return;
  }
  await markCompacted($);
  if (!(await $.state.get(CARRIED)).value) {
    const text = await carriedText($, handoff);
    const added = text ? await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } }) : null;
    if (!added || added.deny) $.ui.log(`the handoff could not be carried into the new context${added?.deny ? ` (${added.deny})` : ""}`);
  }
  await $.state.set(SWITCHED, { at: await $.clock.now(), percent });
  $.ui.toast(`Checkpoint at ${percent}%: switched to a fresh context with ${handoff.path}`, { timeoutMs: 8000 });
}

// Why the free pre-filter holds a check back, or "" when it does not. A todo
// or task unchanged for STALE_TURNS main turns no longer counts.
async function heldBack($, reason) {
  if (reason !== "answer") return `the turn ended with ${reason}`;
  if ((await $.state.get(EDIT_OPEN)).value) return "files were edited and nothing has run since";
  const { value: age = 0 } = await $.state.get(SIGNAL_AGE);
  if (age >= STALE_TURNS) return "";
  if ((await $.state.get(TODO_ACTIVE)).value) return "a todo is in progress";
  if (((await $.state.get(ACTIVE_TASKS)).value ?? []).length > 0) return "a task is in progress";
  return "";
}

async function isWorkSignalled($) {
  if ((await $.state.get(TODO_ACTIVE)).value) return true;
  return ((await $.state.get(ACTIVE_TASKS)).value ?? []).length > 0;
}

async function markCompacted($) {
  await $.state.set(FIRED, false);
  await $.state.set(LAST_CHECK, null);
  await $.state.set(CHECKS_USED, 0);
  await $.state.set(COMPACTED_AT, await $.clock.now());
}

// The handoff as the message that follows the engine's summary, or "" when
// its file is gone or empty.
async function carriedText($, handoff) {
  const { value: cwd = "" } = await $.state.get(CWD);
  const text = await $.fs.read(`${cwd}/${handoff.path}`).catch(() => "");
  if (!text.trim()) return "";
  if (!handoff.isEarlier) return carriedHandoff(handoff.path, text);
  const minutes = Math.max(1, Math.round(((await $.clock.now()) - handoff.at) / 60_000));
  return carriedHandoff(handoff.path, text, { percent: handoff.percent, minutes });
}

// A new handoff for this compaction, so it covers the conversation up to the
// last turn. Written even while another handoff is being written (that one
// forked earlier, and a hook may not wait out its budget for it). Null when
// none could be written.
async function handoffForCompaction($, trigger) {
  const { value: cwd = "" } = await $.state.get(CWD);
  $.ui.log(`writing a handoff before ${trigger} compaction`);
  const saved = await writeHandoff(ioFor($), { cwd, reason: `before ${trigger} compaction`, isForced: true });
  return saved.path ? { path: saved.path } : null;
}

// The newest handoff forked since the last compaction (the hard threshold's,
// say), or null. One from before it would only repeat what the summary holds.
async function earlierHandoff($) {
  const { value: last = null } = await $.state.get(LAST);
  const { value: compactedAt = 0 } = await $.state.get(COMPACTED_AT);
  if (!last || !(last.startedAt > compactedAt)) return null;
  $.ui.log(`no new handoff for this compaction; carrying ${last.path} from ${last.percent ?? "?"}%`);
  return { path: last.path, at: last.at, percent: last.percent, isEarlier: true };
}

async function settingsOf($, fallback) {
  return readSettings(await $.store.get("settings"), fallback);
}

// The plain functions writeHandoff takes, over the engine interface.
function ioFor($) {
  return {
    fork: (prompt) => $.model.fork({ prompt }),
    read: (path) => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: (path) => $.fs.exists(path),
    now: () => $.clock.now(),
    percent: async () => (await $.session.usage()).context?.percent,
    isBusy: async () => (await $.state.get(BUSY)).value === true,
    setBusy: (v) => $.state.set(BUSY, v),
    setLast: (v) => $.state.set(LAST, v),
    latestStart: async () => (await $.state.get(LATEST_START)).value ?? 0,
    setLatestStart: (v) => $.state.set(LATEST_START, v),
    toast: (text) => $.ui.toast(text, { timeoutMs: 6000 }),
    log: (text) => $.ui.log(text),
  };
}

// Forks the conversation for a handoff, writes it under <cwd>/handoff/, points
// LATEST.md at it and makes sure git ignores the folder. Takes plain functions.
// A forced write (a compaction's) runs beside a write already under way; of
// two that overlap, the one that forked later keeps LATEST.md, whichever ends
// first, and the other's file is kept beside it. Everything after the fork
// runs one write at a time, so two never pick the same name.
export async function writeHandoff(io, { cwd, reason, isForced = false }) {
  if (!cwd) return { skipped: "no working directory" };
  if (!isForced) {
    if (await io.isBusy()) return { skipped: "busy" };
    await io.setBusy(true);
  }
  try {
    const startedAt = await io.now();
    const percent = io.percent ? await io.percent() : undefined;
    const reply = await io.fork(HANDOFF_PROMPT);
    if (!reply.isAnswered) {
      io.log(`no handoff written, the fork returned ${reply.reason}`);
      io.toast("Handoff was not saved. Try /autohandoff now again.");
      return { skipped: reply.reason };
    }
    const { summary, body } = splitReply(reply.text);
    if (!body.trim()) throw new Error("The summary response was empty");
    const { path, isNewest, gitignore } = await oneAtATime(async () => {
      const now = await io.now();
      const dir = `${cwd}/handoff`;
      const stamp = timestamp(now);
      let name = `handoff-${stamp}.md`;
      for (let n = 2; await io.exists(`${dir}/${name}`); n++) name = `handoff-${stamp}-${n}.md`;
      const project = cwd.split("/").filter(Boolean).pop() ?? "project";
      const header = `# Handoff, ${project}, ${humanTime(now)}\n\n_Written automatically by auto-handoff (${reason})._\n\n`;
      await io.write(`${dir}/${name}`, header + body.trim() + "\n");
      const path = `handoff/${name}`;
      const isNewest = startedAt >= (await io.latestStart());
      if (isNewest) {
        await io.setLatestStart(startedAt);
        await io.write(`${dir}/LATEST.md`, `${name}\n${summary}\n`);
        await updateActiveProject(io, dir, name, summary);
        await io.setLast({ path, at: now, reason, startedAt, percent });
      }
      return { path, isNewest, gitignore: await ensureIgnored(io, cwd) };
    });
    io.toast(`Handoff saved to ${path}`);
    io.log(`saved ${path}${isNewest ? "" : " (a newer handoff keeps LATEST.md)"}${gitignore ? `, ${gitignore}` : ""}`);
    return { path, gitignore };
  } catch (err) {
    io.log(`writing the handoff failed (${err?.message ?? err})`);
    io.toast("Handoff was not saved. Try /autohandoff now again.");
    return { skipped: "error" };
  } finally {
    if (!isForced) await io.setBusy(false);
  }
}

// The tail of the handoff's writing, from picking a name to LATEST.md, one
// write at a time. The queue is this module's; a reload starts a new one.
let queue = Promise.resolve();
function oneAtATime(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// The engine's summary names the full transcript file; the lookup sentence
// points at it rather than at a path this plugin cannot read on every tier.
// An earlier handoff (the new one failed) says how old it is and yields to
// the summary on what came after it.
const LOOKUP =
  "If a detail is missing from both, search the full transcript file the summary names with grep for that detail; never read it whole.";
export function carriedHandoff(path, text, earlier) {
  if (!earlier) {
    return `[auto-handoff] The conversation was just compacted. Below is the handoff written right before it (${path}). For decisions, current state and next steps, treat this handoff as authoritative and the summary above as background. ${LOOKUP}\n\n${text.trim()}\n`;
  }
  const fill = earlier.percent === undefined ? "" : ` at ${earlier.percent}% context fill,`;
  return `[auto-handoff] The conversation was just compacted. A fresh handoff could not be written, so below is the latest one from before it (${path}), written${fill} about ${earlier.minutes} min before the compaction. Treat it as authoritative for decisions and next steps up to that point; where the summary above describes later work, the summary wins. ${LOOKUP}\n\n${text.trim()}\n`;
}

export function parseCheckpoint(reply) {
  if (!reply?.isAnswered) return { isCheckpoint: false, why: `no verdict, ${reply?.reason ?? "no reply"}` };
  const m = /^\s*CHECKPOINT:\s*(yes|no)\b\s*(?:[-:]\s*)?(.*)$/im.exec(reply.text ?? "");
  if (!m) return { isCheckpoint: false, why: "unreadable verdict" };
  return { isCheckpoint: m[1].toLowerCase() === "yes", why: oneLine(m[2]) || "no reason given" };
}

// The /prime skill reads ACTIVE_PROJECT.md first; keep it in step when it
// names this folder (".") or is missing, and leave a nested pointer alone.
async function updateActiveProject(io, dir, name, summary) {
  const path = `${dir}/ACTIVE_PROJECT.md`;
  if (await io.exists(path)) {
    const text = await io.read(path).catch(() => "");
    if (firstLine(text) !== ".") return;
  }
  await io.write(path, `.\n${name}\n${summary}\n`);
}

// Appends handoff/ to an existing .gitignore that lacks it, or creates one in
// a git repo that has none. Returns what it did, or "" when nothing changed.
export async function ensureIgnored(io, cwd) {
  const path = `${cwd}/.gitignore`;
  if (await io.exists(path)) {
    const text = await io.read(path);
    if (ignoresHandoff(text)) return "";
    const sep = text === "" || text.endsWith("\n") ? "" : "\n";
    await io.write(path, `${text}${sep}handoff/\n`);
    return "added handoff/ to .gitignore";
  }
  if (await io.exists(`${cwd}/.git`)) {
    await io.write(path, "handoff/\n");
    return "created .gitignore with handoff/";
  }
  return "";
}

export function ignoresHandoff(text) {
  return text.split(/\r?\n/).some((line) => /^\/?handoff(\/(\*\*?)?)?$/.test(line.trim()));
}

export function splitReply(text) {
  const lines = text.replace(/^\s+/, "").split("\n");
  const m = /^LATEST:\s*(.+)$/.exec(lines[0] ?? "");
  if (m) return { summary: oneLine(m[1]), body: lines.slice(1).join("\n") };
  return { summary: "Auto handoff written by auto-handoff.", body: text };
}

export function timestamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function humanTime(ms) {
  const s = timestamp(ms);
  return `${s.slice(0, 10)} ${s.slice(11, 13)}:${s.slice(13, 15)}:${s.slice(15, 17)}`;
}

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function statusText(settings, percent, lastLine, switchLine, checkLine) {
  const fill = percent === undefined ? "not measured yet" : `${percent}%`;
  const switching = settings.isSwitching
    ? `switches to a fresh context at a checkpoint from ${settings.soft}% (checked every ${settings.step}%)`
    : "checkpoint switching off";
  return [
    `Auto handoff is ${settings.isEnabled ? "on" : "off"}, context fill ${fill}.`,
    `It ${switching}, and writes a handoff without switching at the hard threshold ${settings.threshold}%.`,
    lastLine,
    switchLine,
    checkLine,
    "Commands are /autohandoff now, resume, soft <n>, hard <n>, step <n>, switch on|off, on, off.",
  ].filter(Boolean).join("\n");
}

function readSettings(stored, fallback) {
  const s = asObject(stored);
  return {
    threshold: toPercent(s.threshold) ?? fallback.threshold,
    soft: toPercent(s.soft) ?? fallback.soft,
    step: toStep(s.step) ?? fallback.step,
    isEnabled: typeof s.isEnabled === "boolean" ? s.isEnabled : fallback.isEnabled,
    isSwitching: typeof s.isSwitching === "boolean" ? s.isSwitching : fallback.isSwitching,
  };
}

function toPercent(v) {
  return toInt(v, 1, 99);
}

function toStep(v) {
  return toInt(v, 1, 20);
}

function toInt(v, min, max) {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return Math.round(n);
}

function asObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function firstLine(text) {
  return (text ?? "").split(/\r?\n/)[0].trim();
}

function oneLine(text) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}
