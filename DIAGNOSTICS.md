# Long-running agent diagnostics

Diagnostics start automatically with `npm start` and the `kairos` CLI. Restart the running process after updating. No live transactions are needed to run the checks below.

Use the installed Node 24 runtime (`nvm use 24`). The project shell selected Node 16 during verification, below the minimum in `package.json`; the checks below passed using Node 24.15.0.

Metadata is written to `./logs/diagnostics-<PID>.jsonl` relative to the launch directory. Each process retains a current file and two backups of approximately 5 MB each. Files from previous PIDs remain available for investigation; remove old runs when no longer needed. Set `KAIROS_DIAGNOSTICS_DIR` to change the directory or `KAIROS_DIAGNOSTICS=false` to disable diagnostics.

Every 30 seconds, `runtime_sample` records RSS, heap, external/buffer memory, heap limit, memory deltas, CPU use, event-loop delay, GC count/duration, active resource types, and task counts. Task events correlate by `runId`, `taskId`, and `parentTaskId`. Queued and active task metadata is capped at 256 entries; `untrackedTasks` reports any excess. Task functions, prompts, tool arguments/results, and error messages are not retained in the diagnostic registry or written to this diagnostic file. Existing application logs retain their existing behavior.

## Reproduce and interpret

1. Start the agent normally. Note the PID and diagnostic file.
2. Submit task A, then task B before A finishes. Record the approximate time and input channel (terminal or Telegram).
3. Wait for completion or the stall warning, then retain the current log and backups. A stall is reported after 120 seconds without progress; this is evidence to investigate, not proof of a leak or infinite loop.

| Evidence | Investigate |
| --- | --- |
| Heap baseline keeps rising after work drains | Retained objects/history; compare heap profiles |
| RSS grows while heap stays stable | Buffers, native allocations, allocator retention; inspect external/arrayBuffers |
| Queued count and wait time rise | Producers outpace workers, or a worker is blocked |
| `task_started` without completion/failure, followed by `task_stalled` | Hung LLM/tool/send; follow parent/child task IDs |
| `repeated_tool_call` | Same tool and exact arguments repeated within one agent run |
| `llm_attempt_failed`, `agent_retry` | Provider failures and retry/backoff |
| `agent_step_limit` or `agent_timeout` | Loop guard reached; the timeout is checked between steps, not cancellation of an in-flight operation |
| Rising prompt tokens/content bytes | Growing model context/tool output |
| High CPU and event-loop delay | Synchronous work or a busy loop |
| Increasing active resource counts | Timers, sockets, or handles accumulating |
| `repl_busy_rejected` | Terminal input was rejected by the busy guard; terminal requests are not queued |
| `telegram_plain_fallback` | Rich-message API rejected a send; fallback runs after releasing the queue worker |
| `shutdown_started` without completion | Shutdown failed or stalled |

`task_completed` means the function resolved. A resolved tool/provider result can still report failure; correlate with agent error and provider events. Repeated user submissions get different task IDs; only repeated calls inside one agent run are flagged automatically. Child-process RSS, OS OOM kills, and native allocation ownership require external process monitoring/profiling. A fully blocked event loop cannot emit its periodic sample until it recovers; abrupt termination can leave no final event. These logs do not prove every possible leak.

## Offline checks

```sh
node --test test/test-diagnostics.js
```
