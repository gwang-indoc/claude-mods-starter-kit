# Release notes

## Unreleased
Auto Handoff 0.2.0: past a soft threshold (default 70%) it looks for a natural checkpoint after each turn, at most one model check per 1% of context growth and none mid-edit, then writes a handoff and compacts to a fresh context. Every compaction (auto, /compact or a checkpoint) now writes a new handoff and carries it into the new context after the engine's summary, pointing at the transcript file that summary names. New commands: soft, hard, step and switch on|off; threshold stays as an alias of hard. If the new handoff cannot be written at compaction, the latest one since the last compaction is carried instead, labelled with its fill and age. Checks stop after 15 per compaction cycle, a todo or task unchanged for 10 turns no longer holds them back, read-only commands no longer count as running something after an edit, and status shows the last verdict or what held the check back. Overlapping handoff writes no longer collide on a name or point LATEST.md at the older one. After a compaction the first turn only records a baseline, so a context still past the soft threshold no longer switches on every turn (found in a live interactive test).

## 1.0.0 · October 2, 2026
First viewer kit with ten plugins, ten creation specifications, beginner docs, safe demo launcher and teaching template. Original plugin work was built with Claude Code; this cleaned distribution, docs and packaging were prepared with Codex.

Distribution fixes: Model Router and Output Tray now treat null and undefined agent IDs consistently as the main conversation. Added focused regression tests. Updated router package description to match its default helper-only mode. Original installed plugins were not modified by this packaging task.

No claim of measured savings or full live desktop parity. See VERIFICATION.md.
