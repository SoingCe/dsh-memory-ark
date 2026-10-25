# 记忆库工作区 · 助手操作手册

这个工作区是「记忆方舟」的仓库。你不是来聊天的，是来**保管和搬运记忆**的。

工具都在本目录：`memvault.cmd`（Windows 启动器，自动用 DSH 自带的 Node）。

---

## 备份（把某个会话搬进来）

**一次只备份用户点名的那个工作区里的那一个会话。**
不要备份整个工作区的所有会话；用户明确说「全部」才用 `--all`。

用户说「备份 xxx 工作区」「把这里的记忆存一下」时：

1. 先看有哪些工作区、工作区 ID 是什么：

   ```bat
   memvault.cmd workspaces
   ```

   用户没点名就**把列表给他选**，选完只认那一个工作区；不要替他挑。

2. 列出这个工作区的会话，把「序号 + 标题 + 时间」给他挑：

   ```bat
   memvault.cmd sessions --workspace-id <工作区ID>
   ```

3. 用户挑好序号（或给了会话 id）后，先预览：

   ```bat
   memvault.cmd backup --workspace-id <工作区ID> --session <序号或会话id> --dry-run
   ```

4. 确认无误再真正备份：

   ```bat
   memvault.cmd backup --workspace-id <工作区ID> --session <序号或会话id>
   ```

   - `--session` 认序号（以第 2 步的顺序为准）、完整会话 id、或唯一前缀。
   - 用户只给了会话 id：直接 `memvault.cmd backup --from-session <会话id>`，它会反查工作区，且只备份这一条。
   - 用户明确说「全部备份」才用 `--workspace-id <ID> --all`。

5. 汇报：备份了哪个会话、多少条消息、有没有失败。**不要**把 `raw.jsonl` 的内容大段贴到聊天里。

> 备份只读源工作区的会话文件（`~\.dsh\sessions`），写到本工作区的 `vault/`。
> 不要试图 `cd` 到别的工作区再写文件——沙箱会拒绝，而且没必要。

---

## 提炼（把对话变成记忆卡）

用户说「提炼」「整理记忆」时：

1. 生成分段：

   ```bat
   memvault.cmd chunks --source <代号> [--session <会话id>]
   ```

2. 每段 `vault/work/<会话id>/chunk-*.md` 派一个子代理去读，按 `DISTILL_PROMPT.md` 的规则产出 JSON：

   - 只记：身份/称呼/性格/喜好/忌讳、重要的人和关系、约定与承诺、长期项目与进展、关键决定与理由、反复出现的兴趣、用户明确要求记住的事。
   - 不记：寒暄、一次性操作步骤、工具调用细节、路径和命令、通用知识、过期且无结果的临时安排。
   - `text` 用第三人称、主语「用户」、一句话 ≤80 字。
   - 每条带 `date`（YYYY-MM-DD）、`kind`、`importance`、`tags`。
   - **宁可少写，不要编造。** 分片里没有的就返回空数组。

3. 把子代理返回的卡片合并成一个文件（可以带 `source` / `session` 字段），然后：

   ```bat
   memvault.cmd save-cards --file <卡片文件>.json --source <代号> --session <会话id>
   ```

4. 跑 `memvault.cmd review` 生成勾选页，把路径告诉用户。

5. 汇报新增多少条、重复多少条；把最值得的 3~5 条摘要给用户看。

---

## 提取（把记忆送到别的工作区）

用户说「把 xxx 的记忆带过去」「找一下关于 xxx 的记忆」时：

1. 搜：

   ```bat
   memvault.cmd search <关键词> --limit 15
   memvault.cmd search <关键词> --deep      :: 连原文一起搜
   ```

2. 把候选按「日期 · 类型 · 一句话」列给用户，**让用户挑**。或者让用户开 `vault/review.html` 勾选。

3. 用户挑完：

   ```bat
   memvault.cmd keep <id...> --session <目标会话id>
   ```

   - `--session` 不填就取当前工作区最近的会话。
   - 会写目标工作区的 `MEMORY.md`，并调「鱼的记忆」接口写进那个会话。
   - 插件连不上会自动退化成只写 `MEMORY.md`，照常汇报。

> `keep` 必须在**目标工作区**里跑（因为要写那个工作区的 `MEMORY.md`）。
> 如果你人在记忆库工作区，先让用户切到目标工作区，或者用 `--workspace <目标路径>`（沙箱允许写时才行）。

---

## 硬规矩

- **不要改 `vault/sources/**/raw.jsonl`** —— 那是原始证据，只读。
- **不要删 `vault/` 里的东西**，除非用户明确要求；`cards.json` 可以手工修卡片文字。
- **不要把 `raw.jsonl`、`MEMORY.md` 全文贴进聊天**，摘要即可；里面有 UID、路径等隐私。
- 备份/提炼/提取做完各汇报一次，别默默跑完不说。
- 用户说「同步/防丢」时：`memvault.cmd mirror --to <目录>`。
- 拿不准源工作区是哪个：先 `memvault.cmd workspaces`，再问一句，别猜着备份错地方。

---

## 常用命令速查

```bat
memvault.cmd status
memvault.cmd workspaces
memvault.cmd sessions --workspace-id <工作区ID>
memvault.cmd backup --workspace-id <工作区ID> --session <序号|会话id>
memvault.cmd backup --from-session <会话id>
memvault.cmd chunks --source <代号>
memvault.cmd save-cards --file cards.json --source <代号> --session <会话id>
memvault.cmd search 关键词 --limit 15
memvault.cmd review
memvault.cmd keep <id...> --session <会话id>
memvault.cmd doctor
```
