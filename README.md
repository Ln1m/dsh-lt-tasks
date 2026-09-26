# dsh-lt-tasks

多窗口接力推进长期任务的 DeepSeek Harness 插件。

任务 = 持久文件夹（11 个存档文档 + 极简对接文档 + 锁），不绑定任何窗口；靠「极简对接文档（索引）+ 存档」交接，AI 按需定位文档，把长上下文 / 遗忘降到最低。

[English](README.en.md)

## 界面

![Tasks 视图](https://cdn.jsdelivr.net/gh/Ln1m/dsh-lt-tasks@main/docs/screenshot.png)

## 功能

- **11 业务文档 + meta**：`meta`（机器元数据）+ `handoff / goal / frozen / tasklist / next / progress / refs / index / errors / blockers / review` 共 11 个业务文档，一类内容一个文档。
- **极简对接文档**：`handoff.md` 只存各文档**完整路径** + 下次推进一句话，推进时 AI 按需 `read`，不通读。
- **多窗口接力**：任何窗口「推进长期任务 xxx」→ 读 handoff 索引 → 按需定位 → 执行 → 存档，不依赖历史对话。
- **6 态状态机**：筹划中 / 进行中 / 已暂停 / 已阻塞 / 待审 / 已完成。
- **并发锁**：`.lock`（session + 时间戳），单窗口推进，超时可配。
- **参考资料只读**：复制到 `refs/` 后打 Windows 只读属性。
- **目录索引**：`index.md` / `refs.md` 记录文件绝对路径 + Markdown 章节，可定位到文档内部。
- **任务完成度**：tasklist 的 checkbox 自动统计完成/总数。
- **前端视图**：左栏「任务」tab，分组折叠列表 + 搜索 + 详情抽屉 + inline 编辑 + 状态下拉。
- **任务↔对话关联**：推进时记录对话 session，点任务详情自动打开对应对话。
- **输入框预填**：点「＋」新建任务 / 详情页「＋新对话」时，自动在对话输入框预填引导语（`请帮我新建一个长期任务：` / `推进长期任务 xxx`），不自动发送，补充要求后由你主动发送。
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

## 用法

### 模型工具（9 个）

| 工具 | 作用 |
|---|---|
| `create_task` | 新建任务（筹划中），可选 `refPath` 复制参考资料到 `refs/` 并只读 |
| `list_tasks` | 列出所有任务及状态 |
| `get_task` | 读某任务存档（meta + 9 个业务文档，blockers/review 需单独 read） |
| `advance_task` | 推进：加锁、筹划中则置进行中，返回极简 handoff 索引 |
| `save_progress` | 存档：写总结/改动/决策/阻塞（自动置 blocked）/审查，版本 +1，解锁 |
| `pause_task` / `resume_task` | 暂停（解锁）/ 恢复 |
| `complete_task` | 完成，生成归档建议（不自动写知识库） |
| `delete_task` | 删除任务（连同文件夹，不可恢复） |

典型流程：`create_task` →（筹划）→ `advance_task` → 工作 → `save_progress` → … → `complete_task`。

## 目录结构（产出与内部约定分离）

```
<DSH_LT_TASKS_ROOT>/<任务名>/          # 内部约定（任务库，存管理文档）
  meta.md / handoff.md / goal.md / frozen.md / tasklist.md / next.md /
  progress.md / refs.md / index.md / errors.md / blockers.md / review.md
  .lock

<DSH_LT_WS_ROOT>/lt-task-NNN-<主题>/   # 实际产出（桌面工作区，与会话文件夹同编号规则）
  ...产出文件...
  refs/                                # 参考资料（只读）
```

任务库只存「内部约定」（11 文档 + 锁）；实际产出一律落在桌面产出工作区 `lt-task-NNN-<主题>` 文件夹（NNN 为已有序号 + 1，独立编号）。`handoff.md` / `index.md` 记录产出区路径，创建任务后请把文件树切到产出区（`switch_workspace_root`）再开工。

## 版本快照与回退（备份规则）

每次存档（`save_progress`，版本 +1）自动在**对应产出工作区**内同步生成完整版本快照，无需手动备份，可随时回退：

- **快照路径**：`<产出工作区>/backups/v<N>/`（N = 版本号；`create_task` 时自动生成 **v1 基线**）
  - `task-docs/` —— 该版本的任务库 11 文档 + `meta.md`
  - `workspace/` —— 该版本的工作区全部产出文件（自动排除 `backups/` 自身，不嵌套）
- `save_progress` 返回值带 `backupPath`，即本次快照目录。
- **版本链连续**：v1（创建）→ v2（首次存档）→ … → vN（最新），每一存档点独立完整，互不覆盖。
- **回退方法**：
  - 产出文件回退：把 `backups/v<N>/workspace/` 下文件复制回工作区根覆盖即可。
  - 任务库文档回退：把 `backups/v<N>/task-docs/` 下文件复制回 `<DSH_LT_TASKS_ROOT>/<任务名>/` 覆盖（连 `meta.md` 一起覆盖即回到当时版本号）。
- **空间说明**：快照为全量复制（非增量），占用 ≈ 工作区产出体积 × 推进次数；工作区以文档/代码为主（仿真大文件请留在 `D:\PLECS-Tools` 等自有目录，勿放入工作区）。
- **删除任务**（`delete_task`）会连同工作区 `backups/` 一并删除、不另行保留 —— 删除前会先列明细经你确认。

## 开发

```
plugins/lt-tasks/
├── lib/index.js      # host 入口：注册工具 + HTTP 路由
├── lib/store.js      # 任务存储、状态机、目录索引、原子写
├── lib/lock.js       # 并发锁
├── lib/readonly.js   # 只读属性
├── lib/tools.js      # 9 个模型工具
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
