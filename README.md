# 🐋 记忆方舟（dsh-memory-ark）

一个 DSH 宿主插件：**每天到点，把你选中的那个工作区里的那个会话，备份进「记忆方舟」记忆库。**

它不重复实现备份逻辑，直接调用记忆库里的 `memvault.mjs`，所以和手动备份完全同一条路。

---

## 它做什么

- 设置页里选：**工作区 → 会话 → 每天几点 → 开/关**。
- 到点自动跑：
  ```
  memvault.mjs backup --workspace-id <工作区ID> --session <会话ID> --vault <记忆库>
  ```
- 只备份你选的那一个会话，不碰同工作区的其他会话。
- 会话没变化时，memvault 会自己跳过（增量）。
- 每次结果写进 `~/.dsh/memory-ark/state.json` 和 `run.log`，设置页能看。
- **补跑**：DSH 关着时到点不会跑；下次打开 DSH 后，会把最近错过的那一次补上。

> 限制：插件活在 DSH 进程里，**DSH 没开就不会在后台跑**。
> 只要 DSH 当天/第二天会打开，补跑就能把那次备份补上。

---

## 前置：记忆库（已自带，可选替换）

插件自己不备份，它调用 `memvault.mjs`。**这个包已经自带一份**（装在插件的 `memory-vault\` 里），所以只装插件就能用。

想把记忆库放在自己选的工作区里，就把 `memory-vault\` 拷过去、在 DSH 里添加成工作区；插件会优先用你那份。

查的顺序：

1. 环境变量 `MEMORY_ARK_MEMVAULT`（填 `memvault.mjs` 的绝对路径）；
2. DSH 里登记过的每个工作区里的 `memory-vault/memvault.mjs`；
3. 插件包里自带的那份（`<插件目录>\memory-vault\memvault.mjs`）；
4. 老式布局：`%USERPROFILE%\Documents\deepseek-harness\*\memory-vault\memvault.mjs`。

用自带那份时，默认记忆库落在 `~/.dsh/memory-ark/vault` —— 不能放 `node_modules` 里，pnpm 重装会把库一起冲掉。

> 包里**不含** `vault/`（那是你的记忆本体，谁装都该是自己的）。

## 安装

一条命令，走 pnpm 装进 profile（**别往 `node_modules` 里手抄**，pnpm 下次整理依赖树会把它当成孤儿挪进 `.ignored`）：

```powershell
# 从 GitHub 装（推荐：钉死 commit，别人装到的和你一样）
dsh plugin --profile desktop add github:<用户名>/dsh-memory-ark#<commit>

# 从本地压缩包装（把 .tgz 发给别人，对方改成他那边的路径）
dsh plugin --profile desktop add file:C:/path/to/dsh-memory-ark-0.4.1.tgz

# 从任意 tar.gz 直链装（release 附件、对象存储都行）
dsh plugin --profile desktop add https://example.com/dsh-memory-ark-0.4.1.tgz
```

装完 profile 的 `dsh.profile.bundles` 会自动多出 `dsh-memory-ark` 一行。**然后重启一次 DSH。**

> `github:` 这种写法要机器上有 git。没装 git 就用 codeload 直链：
> `https://codeload.github.com/<用户名>/dsh-memory-ark/tar.gz/<commit>`
> （本机就是这么装的：git 缺失时 `github:` 会在 `git ls-remote` 那一步直接失败。）

---

## 用

重启后，**DSH 设置 → 记忆方舟**（和「鱼的记忆」「朗读」并排）。

设置页里：

1. 选工作区；
2. 选会话（只列这个工作区的）；
3. 填时间（默认 23:30）；
4. 勾「每天自动备份一次」；
5. 保存。

`memvault.mjs` 由插件自动找（`Documents\deepseek-harness\*\memory-vault\memvault.mjs`），设置页里**不显示、也不可改**，避免误改把备份弄坏。

「高级」里只有一条 **记忆库目录**：

- 点「选择…」会弹系统文件夹选择框，选完自动填进来；
- 也可以直接粘绝对路径；
- 留空 = `memvault.mjs` 旁边的 `vault\`；
- **换目录不会自动搬旧数据**，旧库还在原来的位置。

可以点「立即备份一次」先验证；结果显示在下面。

> 如果设置里没看到「记忆方舟」：确认 `package.json` 里有 `dsh.client` 那一段、`client.js` 已复制进去，然后重启 DSH。
> 浏览器页面 `/dsh-memory-ark/page` 仍然保留，作为没有客户端 UI 时的兜底。

---

## 文件

```
~/.dsh/memory-ark/
  config.json    选中的工作区/会话/时间/开关
  state.json     上次跑的时间、结果
  run.log        每次备份的输出（超过 512KB 自动截断）
```

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-memory-ark
```

再把 profile `package.json` 里 `dsh.profile.bundles` 的 `"dsh-memory-ark"` 一行删掉，重启 DSH。
想清干净，最后删 `~/.dsh/memory-ark/`（配置、状态、日志都在那）。

## 说明

- 插件的备份动作交给 `memvault.mjs`，所以记忆库那边的路径、格式、增量规则都不变。
- 只备份原文，不自动提炼记忆卡；要提炼还是 `memvault chunks` / `save-cards`。
- 插件读的是 `~/.dsh/sessions`，写的是记忆库目录；这两件事都在 DSH 宿主里做，不走 agent 沙箱。
