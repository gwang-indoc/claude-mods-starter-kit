# Auto Handoff

Writes a summary of progress, decisions and next steps into the project. Past 70% context it waits for a natural checkpoint, such as research done or a bug fixed and verified, then compacts to a fresh context that starts from that summary. Every compaction carries the summary into the new context.

See [the complete guide](../../guides/10-auto-handoff.md) and [creation prompt](../../prompts/10-auto-handoff.txt).

Test from the kit root:
```bash
claude plugin validate plugins/auto-handoff
claude plugin test plugins/auto-handoff
```
