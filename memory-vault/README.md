# 🐋 记忆方舟（memvault）

给 DSH 工作区做**跨工作区的记忆备份**：

```
工作区 A（快满了）                    记忆库工作区                      工作区 B（要记忆）
┌──────────────────┐           ┌────────────────────┐           ┌──────────────────┐
│ 会话 1..N        │  备份 →   │ sources/ 全量原文  │  提取 →   │ MEMORY.md        │
│ 鱼的记忆          │           │ cards.json 记忆卡  │  挑选     │ 鱼的记忆（召回）  │
│ 工作区文档        │           │ review.html 勾选页 │           │ 继续聊            │
└──────────────────┘           └────────────────────┘           └──────────────────┘
```

参考 B 站视频 BV1ednc6jE3j 里「压缩前让另一个会话把整轮对话存下来、再提炼」的做法，
把它做成可重复的三步：**备份 → 提炼 → 提取**。

- **备份**：把你指定的那一个会话的完整记录（含工具结果）、鱼的记忆、工作区里的 md/txt 文档搬进记忆库；想整个工作区全量才加 `--all`。
- **提炼**：让模型把对话改写成一条条带日期、标签、重要度的「记忆卡」。不占原工作区上下文。
- **提取**：在新工作区里搜/勾选需要的记忆，写进 `MEMORY.md`，同时塞进「鱼的记忆」插件，之后它自己会想起来。

零依赖，只用 DSH 自带的 Node（v22.15+，用到 `node:zlib` 的 zstd）。

---

## 一、把记忆库变成 DSH 工作区

1. DSH 左上角工作区菜单 → **添加工作区**，路径填：

   ```
   <你的工作区路径>\memory-vault
   ```

2. 在这个工作区里开一个新会话。

> 备份要写记忆库，所以**备份动作得在能写 `memory-vault\vault\` 的会话里跑**。
> 记忆库现在就放在 `default-workspace` 里面，所以在 `default-workspace` 里跑也行；
> 以后把记忆库挪到别的工作区或别的盘，就在记忆库自己的工作区里跑（DSH 文件沙箱只允许写当前工作区）。
> 读取别的工作区的会话不受影响，因为会话文件都在 `~\.dsh\sessions` 里。

> 想让记忆库真正独立：把整个 `memory-vault` 文件夹搬到别的地方（比如 `D:\memory-vault`），
> 再按上面两步重新添加为工作区。`memvault` 的默认库路径跟着脚本走，命令不用改。

---

## 二、备份一个会话

**一次只备份你指定的那一个会话**，不会把整个工作区的会话都搬走；要整个工作区得显式加 `--all`。

先看工作区，再列这个工作区的会话：

```bat
memvault.cmd workspaces
memvault.cmd sessions --workspace-id 94626f81-ca7e-4ee8-9041-07b8c4100b88
```

`sessions` 按最近活动排序，给出序号：

```
 1. 2026-10-25 21:38   工作区记忆备份与提取
    9 条 · 1.0 MB · session-4515378c-f7b6-43ab-9141-7bd26acb013f
 3. 2026-10-25 21:34   备份记忆
    3 条 · 78.3 KB · session-ed104a7f-62fa-4164-9e94-977a7055b02d
```

然后只备份第 1 个：

```bat
memvault.cmd backup --workspace-id 94626f81-ca7e-4ee8-9041-07b8c4100b88 --session 1
```

`--session` 既认序号，也认会话 id 或前缀（序号以 `sessions` 那次的顺序为准）。

- **终端里**不写 `--session`：会列出会话让你输序号。
- **在 DSH 里**没有交互终端：助手会先跑 `sessions` 把清单给你挑，再带 `--session` 跑。
- 整个工作区（不推荐，除非确实要全量）：`backup --workspace-id ... --all`。
- 手里只有会话 id：`backup --from-session session-...`，自动反查它属于哪个工作区，只备份这一条。
- `--dry-run` 先预览；`--force` 强制重做。

### 三种标识，别搞混

| 标识 | 例子 | 是什么 | 稳不稳 |
|---|---|---|---|
| **工作区 ID** | `94626f81-ca7e-4ee8-9041-07b8c4100b88` | 一个工作区本身 | 最稳；只要不删掉再重加就不变 |
| 记忆库代号 | `default-workspace-90b3de` | 路径 + 短哈希 | 路径不变就不变 |
| session id | `session-4515378c-…` | **一个会话**，不是工作区 | 会话不删就不变，但一个工作区有很多个 |

> session id 是唯一且固定的，**但它代表一条会话**。一个工作区有多个会话，还可能有一堆不属于任何工作区的子代理会话。
> 所以先用工作区 ID 圈定范围，再用 session id（或 `sessions` 给的序号）指定其中一条。

会写出：

```
vault/
  index.json                         总索引
  sources/<代号>/
    sessions/<会话id>/
      transcript.md                  人能读的对话（工具结果截断）
      raw.jsonl                      完整原文（含工具结果、原始记录）
      meta.json                      标题、时间、条数、哈希
      memory.json                    这个会话在「鱼的记忆」里的存档（如果有）
    workspace-files/                 工作区根目录的 md/txt 文档
  cards.json                         记忆卡
  review.html                        勾选页
```

> 备份是**全量**的：`raw.jsonl` 里连工具调用和结果都在。
> 里面有登录态、UID、本机路径之类的信息，**别把 vault 目录发给别人**。

---

## 三、提炼成记忆卡

```bat
:: 只提炼刚备份的那一个会话
memvault.cmd chunks --source default-workspace-90b3de --session <会话id>
```

每段对话生成 `vault/work/<会话id>/chunk-01.md`，以及给模型看的 `DISTILL_PROMPT.md`。

在 DSH 里直接说：

> 把这些 chunk 提炼成记忆卡，存进记忆库。

（记忆库工作区的 `AGENTS.md` 已经写好了流程，助手会自己用子代理逐段读、按格式产出。）

或者手工提炼后：

```bat
memvault.cmd save-cards --file cards.json --source default-workspace-90b3de --session <会话id>
```

卡片格式：

```json
{
  "date": "2026-10-25",
  "kind": "fact|preference|event|promise|project|skill",
  "importance": 0.8,
  "tags": ["养鱼", "B站"],
  "text": "用户想养兰寿金鱼，已经在看鱼缸。",
  "quote": "原文依据（可选）"
}
```

`save-cards` 会自动去重（同一句话、或相似度 ≥ 0.9）、补 id、合并进 `vault/cards.json`。

---

## 四、在需要记忆的工作区里提取

在工作区 B（比如新建的会话）里：

```bat
:: 搜记忆卡
memvault.cmd search 养鱼 --limit 10
memvault.cmd search 朗读 --tags 偏好 --deep

:: 生成勾选页，用浏览器打开，勾完复制 ID
memvault.cmd review

:: 把选中的写进当前工作区
memvault.cmd keep m20261025-a0af m20261025-aac7
```

`keep` 做两件事：

1. 在当前工作区根目录写 `MEMORY.md`，维护一段带标记的区块（重复提取会整块替换，不动你手写的其他内容）。
2. 调「鱼的记忆」插件的本地接口，把记忆写进**当前会话**的记忆库，并打开这个会话的记忆开关。之后聊天时它会按鲜活度/相关度自动召回。

> 插件没装、DSH 没开、或者接口换了，会退化成只写 `MEMORY.md`，不影响使用。
>
> `MEMORY.md` 不会被自动读进上下文（DSH 自动读的是 `AGENTS.md`）。想让它每次都看到，在目标工作区的
> `AGENTS.md` 里加一句：`需要长期记忆时，先读 MEMORY.md。`
> 更省事的是靠「鱼的记忆」：`keep` 已经写进当前会话，之后它会自己召回。
> 不想写插件就加 `--no-fish`。

---

## 五、日常节奏（照视频里的习惯）

| 时机 | 做什么 |
|---|---|
| 每次感觉上下文快满 / 快压缩前 | 在记忆库工作区说「只备份 default-workspace 的当前会话」 |
| 每天收工 | 备份当天还在聊的那个会话 + 提炼 |
| 开新工作区 / 新会话 | `search` 找需要的，`review` 勾选，`keep` 带过去 |
| 换电脑 / 防丢 | `memvault.cmd mirror --to D:\backup\memory-vault`（或丢进网盘/ Git） |

DSH 的压缩是自动的，没法在压缩前精确挂钩；所以**别等快满了才备份**，养成「聊完一段就备份这个会话」的习惯最稳。

---

## 六、命令表

| 命令 | 在哪跑 | 干什么 |
|---|---|---|
| `memvault workspaces` | 任意 | 列出工作区、会话数、工作区 ID、记忆库代号 |
| `memvault sessions --workspace-id UUID` | 任意 | 列这个工作区的会话、序号、条数、会话 id |
| `memvault backup --workspace-id UUID --session 序号或会话id`（可加 `--dry-run` / `--force` / `--no-files`） | 记忆库工作区 | 只把**指定的那一个会话**搬进库 |
| `memvault backup --workspace-id UUID --all` | 记忆库工作区 | 整个工作区的所有会话（显式全量，不推荐日常用） |
| `memvault backup --from-session 会话id` | 记忆库工作区 | 反查工作区，只备份这一条会话 |
| `memvault chunks [--source 代号] [--session id] [--chars 24000]` | 记忆库工作区 | 生成提炼分段 |
| `memvault save-cards --file x.json [--source 代号] [--session id]` | 记忆库工作区 | 合并记忆卡、去重 |
| `memvault search 词 [--tags a,b] [--source 代号] [--limit 20] [--deep] [--json]` | 目标工作区 | 按相关度找记忆；`--deep` 连原文一起搜 |
| `memvault review` | 记忆库工作区 | 生成 `vault/review.html` 勾选页 |
| `memvault keep <id...> [--session id] [--no-fish] [--no-memory] [--selection 文件]` | 目标工作区 | 写 `MEMORY.md` + 鱼的记忆 |
| `memvault status` | 任意 | 看库的大小、会话数、卡片数 |
| `memvault mirror --to 路径` | 记忆库工作区 | 把库镜像到别处（跳过 work/） |
| `memvault doctor` | 任意 | 自检：DSH 目录、zstd、库可写、插件接口 |

---

## 七、它不做什么

- **不自动在后台跑。** DSH 的压缩拦不住，备份要你（或助手）主动触发。
- **不导出图片附件。** 会话里的图片只留文字记录；附件在 `~\.dsh\attachments`，需要的话单独拷。
- **不替你判断该记什么。** 提炼靠模型，卡片可以手改；`review.html` 就是给你做最后一道筛选。
- **不是加密保险箱。** 库是明文 JSON/Markdown，自己保管好。

---

## 八、文件结构

```
memory-vault/
  memvault.mjs        CLI 本体
  memvault.cmd        Windows 启动器（自动找 DSH 自带的 Node）
  README.md           本文
  AGENTS.md           记忆库工作区里给助手的操作手册
  vault/              数据（备份、卡片、勾选页）
```

默认记忆库路径是脚本旁边的 `vault/`，也可以用 `--vault <路径>` 指到别处。
