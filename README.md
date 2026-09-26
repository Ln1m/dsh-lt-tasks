# dsh-lt-tasks

多窗口接力推进长期任务的 DeepSeek Harness 插件。

任务 = 持久文件夹（11 个存档文档 + 对接文档 + 锁），不绑定任何窗口；靠「对接文档 + 存档」交接，AI 按需定位文档，把长上下文 / 遗忘降到最低。

[English](README.en.md)

## 界面

![Tasks 视图](https://cdn.jsdelivr.net/gh/Ln1m/dsh-lt-tasks@main/docs/screenshot.png)

## 功能

- **11 业务文档 + meta**：`meta`（机器元数据）+ `handoff / goal / frozen / tasklist / next / progress / refs / index / errors / blockers / review` 共 11 个业务文档，一类内容一个文档。
- **一次拿全的交接**：`advance_task` 直接内联 `next` 全文、`tasklist` 全文、冻结清单摘要与文档规模表，接手窗口读完返回值即可开工，不必再逐个读档案文件。
- **按需分段读**：`get_task` 默认只回文档清单（名 / 字节 / 行数 / 标题）；单个文档超过 8000 字符必须用 `lines:"120-180"` 或 `grep:"正则"` 分段，整读会被拒绝。
- **冻结清单生效**：`freeze_task` 把已确认事项与口径写进 `frozen.md`（追加式，不动已有手写内容），此后每次 `advance_task` 都带冻结摘要，已定的东西不再被当待定项重问；`save_progress` 若命中冻结触发词，会在返回值里告警（不阻断）。
- **对接文档分区**：`handoff.md` 的自动区由工具重写（产出路径 / 开工必读 / 最近 10 条决策），`## 人工补充` 手写区工具永不覆盖。
- **多窗口接力**：任何窗口「推进长期任务 xxx」→ `advance_task` 拿全 → 执行 → `save_progress`，不依赖历史对话。
- **6 态状态机**：筹划中 / 进行中 / 已暂停 / 已阻塞 / 待审 / 已完成。
- **并发锁**：`.lock`（session + 时间戳），单窗口推进，超时可配。
- **参考资料可增补**：建任务时给 `refs`，之后随时用 `add_refs` 补 / 更新——复制前自动解除旧只读再覆盖；超过 200 个文件或 100 MB 的目录只登记绝对路径，不复制。复制进 `refs/` 的按 Windows 只读属性锁定。
- **目录索引**：`index.md` / `refs.md` 记录文件绝对路径 + Markdown 章节，可定位到文档内部。
- **任务完成度**：tasklist 的 checkbox 自动统计完成/总数。
- **前端视图**：左栏「任务」tab，分组折叠列表 + 搜索 + 详情抽屉 + inline 编辑（含参考资料备注与冻结条目数）+ 状态下拉。
- **任务↔对话关联**：推进时记录对话 session，点任务详情自动打开对应对话。
- **输入框预填**：点「＋」新建任务 / 详情页「＋新对话」时，自动在对话输入框预填引导语（`请帮我新建一个长期任务：` / `推进长期任务 xxx`），不自动发送。
- **自成长**：完成时生成归档建议，确认后写入知识库 / skill。

## 安装

1. 把本包放到 profile 可解析位置（如 `~/.dsh/profiles/node_modules/dsh-lt-tasks`）。
2. 在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-lt-tasks
      name: 'dsh-lt-tasks'
```

3. 重启 dsh web 后端。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_LT_TASKS_ROOT` | `~/.dsh/lt-tasks/` | 任务库根目录（内部约定 / 管理文档） |
| `DSH_LT_WS_ROOT` | `D:\Desktop\DSHlongtasks` | 产出工作区根目录（实际产出，桌面侧） |
| `DSH_LT_TASKS_LOCK_TTL` | `24` | 锁超时（小时） |
| `DSH_LT_SNAPSHOT` | `manifest` | 快照模式：`manifest` 只存工作区清单；`full` 额外复制工作区内容 |

## 用法

### 模型工具（13 个）

| 工具 | 作用 |
|---|---|
| `create_task` | 新建任务（筹划中）；`refs` 给源路径则小文件/小目录拷进 `refs/` 并只读，大目录只登记 |
| `list_tasks` | 列出所有任务及状态 |
| `get_task` | 读档案：默认只回文档清单；`docs` 点名取正文，超过 8000 字符必须配 `lines` / `grep` 分段 |
| `advance_task` | 推进：加锁、置进行中，并一次返回 next + tasklist + 冻结摘要 + 文档规模表 + 产出路径 |
| `save_progress` | 存档：写 progress / next、重写 handoff 自动区（手写区保留、决策累积 10 条），可追加冻结项 / 卡点 / 错误 / 审查 / 任务清单，版本 +1 并解锁 |
| `freeze_task` | 追加冻结 / 已定条目（同条目幂等）；口径类行首写「已定：」 |
| `unfreeze_task` | 解除指定冻结条目（用户明确同意后调用） |
| `add_refs` | 建任务后补 / 更新参考资料；先解除旧只读再覆盖，大目录只登记 |
| `list_refs` | 列出 `refs/` 实际文件与仅登记清单 |
| `pause_task` / `resume_task` | 暂停（解锁）/ 恢复 |
| `complete_task` | 完成，生成归档建议（错误与总结各取最近 15 条，不自动写知识库） |
| `delete_task` | 删除任务（连同任务库文件夹与产出工作区，不可恢复） |

典型流程：`create_task` →（筹划）→ `advance_task` → 工作 →`freeze_task` 冻结已定口径 → `save_progress` → … → `complete_task`。

### 文档读取纪律

| 场景 | 做法 |
|---|---|
| 接手开工 | 只调 `advance_task`，返回值已含 next / tasklist / 冻结摘要 / 规模表 |
| 要别的档案 | `get_task` 先看清单，再 `docs` 点名取正文 |
| 大文档（>8000 字符，如 progress / index / frozen） | 用 `grep` 定位行号，或 `lines:"a-b"` 取段；整读被拒 |
| 冻结 / 已定项 | 每次 `advance_task` 都带摘要；改动前按章节定位读原文件，确需改先说明并解冻 |

## 目录结构（产出与内部约定分离）

```
<DSH_LT_TASKS_ROOT>/<任务名>/          # 内部约定（任务库，存管理文档）
  meta.md / handoff.md / goal.md / frozen.md / tasklist.md / next.md /
  progress.md / refs.md / index.md / errors.md / blockers.md / review.md
  .lock

<DSH_LT_WS_ROOT>/lt-task-NNN-<主题>/   # 实际产出（桌面工作区，与会话文件夹同编号规则）
  ...产出文件...
  refs/                                # 参考资料（已复制的部分为只读）
  backups/v<N>/                        # 版本快照（见下）
```

任务库只存「内部约定」（11 文档 + 锁）；实际产出一律落在桌面产出工作区 `lt-task-NNN-<主题>` 文件夹（NNN 为已有序号 + 1，独立编号）。`handoff.md` / `index.md` 记录产出区路径，创建任务后请把文件树切到产出区（`switch_workspace_root`）再开工。

### 参考资料（refs/ 与 refs.md）

- `refs.md` 分两区：**自动区**（`refs/` 实际文件清单 + 仅登记未复制的绝对路径，工具重写）与**手写区**（`<!-- 手写区 -->` 之后，工具永不覆盖，前端「参考资料备注」编辑的就是这里）。
- 复制策略：单个文件或目录按 200 文件 / 100 MB 阈值判定——未超阈值复制进 `refs/` 并置只读；超过则只在 `refs.md` 登记绝对路径。
- 补 / 更新：`add_refs` 会先解除 `refs/` 旧只读属性再覆盖，因此文件可以更新，不会因只读失败。

## 版本快照与回退（备份规则）

每次存档（`save_progress`，版本 +1）在**对应产出工作区**内写一份版本快照：

- **快照路径**：`<产出工作区>/backups/v<N>/`（N = 版本号；`create_task` 时生成 **v1 基线**）
  - `task-docs/` —— 该版本的任务库 11 文档 + `meta.md`（全量，体积小）
  - `manifest.json` —— 该版本工作区清单：相对路径 / 字节 / 修改时间（默认 `manifest` 模式）
  - `workspace/` —— 仅当 `DSH_LT_SNAPSHOT=full` 时生成，为该版本产出的全量副本（自动排除 `backups/` 自身）
- **版本链连续**：v1（创建）→ v2（首次存档）→ … → vN（最新），每一存档点独立，互不覆盖。
- **回退口径**：
  - 任务库文档：把 `backups/v<N>/task-docs/` 下文件覆盖回 `<DSH_LT_TASKS_ROOT>/<任务名>/`（连 `meta.md` 一起覆盖即回到当时版本号）。
  - 产出文件：清单模式只记录路径 / 字节 / 修改时间，用于核对差异后重建；需要内容级快照就先设 `DSH_LT_SNAPSHOT=full` 再存档，或直接取用早先 `workspace/` 已是全量的版本。
- **空间**：清单模式每次只增几 KB，占用不再随工作区体积增长。
- **删除任务**（`delete_task`）会连同工作区 `backups/` 一并删除、不另行保留 —— 删除前先列明细经你确认。

## 开发

```
plugins/lt-tasks/
├── lib/index.js      # host 入口：注册工具 + HTTP 路由
├── lib/store.js      # 任务存储、状态机、文档读写、refs 分区、快照、冻结清单
├── lib/lock.js       # 并发锁
├── lib/readonly.js   # 只读属性（标记 / 解除）
├── lib/tools.js      # 13 个模型工具
├── lib/routes.js     # HTTP 接口（/lt-tasks/*）
├── lib/client.js     # 前端「任务」视图
├── test.mjs          # 核心逻辑单测（node test.mjs）
├── package.json
└── cordis.patch.yml
```

- host 改动需重启 dsh 后端；client 改动刷新页面即可。
- 测试：`node test.mjs`。

## License

MIT
