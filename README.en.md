# dsh-lt-tasks

Multi-window, long-running task management plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A task is a persistent folder (11 archived documents + a handoff document + a lock), **not bound to any window**. Windows hand a task over through the handoff document and the archive, and the agent reads only what it needs — keeping long context and forgetting to a minimum.

[中文](README.md) · English

## Screenshot

![Tasks view](https://cdn.jsdelivr.net/gh/Ln1m/dsh-lt-tasks@main/docs/screenshot.png)

## Features

- **11 business documents + meta**: `meta` (machine metadata) + `handoff / goal / frozen / tasklist / next / progress / refs / index / errors / blockers / review` (11 business docs) — one concern per file.
- **One call to pick up a task**: `advance_task` returns the full `next`, the full `tasklist`, a frozen-list digest and a document size table in a single response, so the next window can start working without reading any file.
- **Read on demand, by segment**: `get_task` returns only a document index (name / bytes / lines / title) by default. A document over 8000 characters must be read with `lines:"120-180"` or `grep:"pattern"`; reading it whole is refused.
- **The frozen list actually applies**: `freeze_task` appends confirmed decisions and settled values to `frozen.md` (append-only, never rewrites existing hand-written content). Every `advance_task` then carries the frozen digest, so settled points are no longer re-opened as open questions; `save_progress` warns (without blocking) when its content touches a frozen trigger word.
- **Zoned handoff**: the auto zone of `handoff.md` is rewritten by tools (workspace path / required reading / last 10 decisions) while the `## 人工补充` manual zone is never overwritten.
- **Multi-window handoff**: any window says "advance task X" → `advance_task` gets everything → work → `save_progress`, with no dependence on chat history.
- **6-state machine**: planning / active / paused / blocked / review / completed.
- **Concurrency lock**: `.lock` (session + timestamp), single window at a time, configurable expiry.
- **References you can keep adding**: pass `refs` when creating a task, then extend or refresh any time with `add_refs` — it clears the old read-only attribute before copying, so files can be updated. Directories over 200 files or 100 MB are only registered by absolute path, not copied. Everything copied into `refs/` is locked with the Windows read-only attribute.
- **Directory index**: `index.md` / `refs.md` record absolute file paths + Markdown headings, so you can jump straight to a section.
- **Progress tracking**: tasklist checkboxes auto-count done/total.
- **Frontend view**: a "Tasks" tab in the left sidebar — grouped collapsible list, search, slide-in detail drawer, inline editing (including reference notes and the frozen-entry count), status dropdown.
- **Task↔session link**: advancing records the session; opening a task detail auto-opens that conversation.
- **Composer prefill**: the "＋" new-task button and the detail "＋ new chat" button prefill a hint into the composer (`请帮我新建一个长期任务：` / `推进长期任务 xxx`) without auto-sending.
- **Self-growth**: on completion, generates an archive suggestion for confirmation before writing to skills.

## Install

1. Place this package where the profile can resolve it (e.g. `~/.dsh/profiles/node_modules/dsh-lt-tasks`).
2. Append to the profile `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-lt-tasks
      name: 'dsh-lt-tasks'
```

3. Restart the dsh web backend.

## Config

| Var | Default | Meaning |
|---|---|---|
| `DSH_LT_TASKS_ROOT` | `~/.dsh/lt-tasks/` | task library root (management docs / internal contract) |
| `DSH_LT_WS_ROOT` | `D:\Desktop\DSHlongtasks` | output workspace root (actual artifacts, desktop side) |
| `DSH_LT_TASKS_LOCK_TTL` | `24` | lock expiry (hours) |
| `DSH_LT_SNAPSHOT` | `manifest` | snapshot mode: `manifest` stores a workspace manifest only; `full` also copies workspace content |

## Tools (13)

| Tool | Purpose |
|---|---|
| `create_task` | create a task (planning); `refs` copies small files/dirs into `refs/` read-only, large dirs are only registered |
| `list_tasks` | list tasks with status |
| `get_task` | read the archive: document index by default; name docs in `docs` for text, over 8000 chars requires `lines` / `grep` |
| `advance_task` | lock, mark active, and return next + tasklist + frozen digest + document size table + workspace path in one call |
| `save_progress` | save progress/next, rewrite the handoff auto zone (manual zone preserved, last 10 decisions kept), optionally append frozen items / blockers / errors / review / tasklist, bump version, unlock |
| `freeze_task` | append frozen / settled entries (idempotent); prefix settled values with `已定：` |
| `unfreeze_task` | remove one frozen entry (only after the user agrees) |
| `add_refs` | add or refresh references after creation; clears the old read-only attribute before copying, large dirs are only registered |
| `list_refs` | list actual files under `refs/` plus the registered-only paths |
| `pause_task` / `resume_task` | pause (unlock) / resume |
| `complete_task` | complete, generate an archive suggestion (last 15 errors + 15 summaries; never writes to skills by itself) |
| `delete_task` | delete a task (task-library folder and output workspace; irreversible) |

Typical flow: `create_task` → (plan) → `advance_task` → work → `freeze_task` to settle values → `save_progress` → … → `complete_task`.

### Document reading discipline

| Situation | Do this |
|---|---|
| Picking a task up | call only `advance_task`; the response already carries next / tasklist / frozen digest / size table |
| Needing other docs | `get_task` for the index, then name the docs you want |
| Large docs (>8000 chars, e.g. progress / index / frozen) | `grep` to locate a line, or `lines:"a-b"` for a slice; reading whole is refused |
| Frozen / settled items | every `advance_task` carries the digest; locate the section in the file before changing, and explain + unfreeze first if a change is truly needed |

## Directory layout (outputs separated from internal contract)

```
<DSH_LT_TASKS_ROOT>/<task>/          # internal contract (task library: management docs)
  meta.md / handoff.md / goal.md / frozen.md / tasklist.md / next.md /
  progress.md / refs.md / index.md / errors.md / blockers.md / review.md
  .lock

<DSH_LT_WS_ROOT>/lt-task-NNN-<topic>/   # actual outputs (desktop workspace, same numbering rule as session folders)
  ...artifact files...
  refs/                              # references (copied parts are read-only)
  backups/v<N>/                      # version snapshots (see below)
```

The task library holds only the internal contract (11 docs + lock). All actual outputs live in the desktop workspace folder `lt-task-NNN-<topic>` (NNN = last sequence + 1, independent numbering). `handoff.md` / `index.md` record the workspace path; after creating a task, switch the file tree to the output folder (`switch_workspace_root`) before working.

### References (`refs/` and `refs.md`)

- `refs.md` has two zones: an **auto zone** (the actual `refs/` file list plus registered-only absolute paths, rewritten by tools) and a **manual zone** (after `<!-- 手写区 -->`, never overwritten — this is what the "参考资料备注" field edits in the UI).
- Copy policy: a file or directory is measured against the 200-file / 100 MB threshold. Under it, it is copied into `refs/` and marked read-only; over it, only its absolute path is registered in `refs.md`.
- Adding / refreshing: `add_refs` clears the stale read-only attribute on `refs/` before copying, so updates never fail on read-only files.

## Version snapshots & rollback (backup rule)

Every `save_progress` (version +1) writes a version snapshot **inside the task's workspace**:

- **Snapshot path**: `<workspace>/backups/v<N>/` (N = version; `create_task` writes the **v1 baseline**)
  - `task-docs/` — the 11 task-library docs + `meta.md` of that version (full, small)
  - `manifest.json` — workspace manifest for that version: relative path / bytes / mtime (default `manifest` mode)
  - `workspace/` — written only when `DSH_LT_SNAPSHOT=full`; a full copy of that version's artifacts (auto-excludes `backups/` itself)
- **Continuous chain**: v1 (create) → v2 (first save) → … → vN (latest); every snapshot is standalone and never overwritten.
- **Rollback**:
  - Task-library docs: copy `backups/v<N>/task-docs/` back over `<DSH_LT_TASKS_ROOT>/<task>/` (overwriting `meta.md` restores that version number).
  - Artifacts: manifest mode records path / bytes / mtime so you can diff and rebuild; for content-level snapshots set `DSH_LT_SNAPSHOT=full` before saving, or use an earlier version whose `workspace/` was already a full copy.
- **Size**: manifest mode adds only a few KB per save, so usage no longer grows with workspace volume.
- **Deleting a task** (`delete_task`) removes the workspace `backups/` too — nothing is kept separately; the itemized list is confirmed before deleting.

## Development

```
plugins/lt-tasks/
├── lib/index.js      # host entry: tools + HTTP routes
├── lib/store.js      # task storage, state machine, doc I/O, refs zones, snapshots, frozen list
├── lib/lock.js       # concurrency lock
├── lib/readonly.js   # read-only attribute (mark / clear)
├── lib/tools.js      # 13 model tools
├── lib/routes.js     # HTTP API (/lt-tasks/*)
├── lib/client.js     # frontend "Tasks" view
├── test.mjs          # core logic tests (node test.mjs)
├── package.json
└── cordis.patch.yml
```

- Host changes require a dsh backend restart; client changes require a page refresh.
- Tests: `node test.mjs`.

## License

MIT
