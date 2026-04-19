---
description: 结束会话录制。把从 /session_record_start 开始的所有用户输入和 Claude 输出归档到 docs/sessions/。
---

你正在结束一个会话录制 session。从最近一次 `/session_record_start` 到现在的所有用户输入和 Claude 输出都要被归档保存。

你的输出 MUST 按以下 Part 严格执行，顺序不能乱。

## Part 0 — 回顾对话，确定会话范围

回看本次对话，找到最近一次 `/session_record_start` 的调用位置。从那个点到现在的全部内容就是要归档的范围。

**如果找不到 `/session_record_start`，直接停止。** 输出以下消息后结束，不要执行后续 Part：

> ⚠️ 未找到 `/session_record_start` 标记，无法归档。请先用 `/session_record_start` 开始录制。

不要回退到 `/my_brainstorm`、`/grill-me` 或其他命令。`/session_record_done` 只与 `/session_record_start` 配对。

## Part 1 — 先起一个 slug，生成草稿文件夹

根据对话内容确定一个 slug（kebab-case，2-5 词），然后调用 Bash 生成草稿文件夹（里面的 `full.md` 含完整时间线，摘要为占位符）：

```bash
node ~/.claude/scripts/session-finalize.mjs --draft <slug>
```

脚本会输出文件夹路径（形如 `docs/sessions/YYYY-MM-DD-<slug>/`），记住这个路径（后续 Part 需要用到）。

## Part 2 — 按需刷新记忆

判断你是否对本次对话的内容有完整的记忆。

**如果你不确定**（比如中间发生过 `/compact`、context 被压缩、或者 session 很长），用 Read 工具读取 Part 1 生成的文件夹下的 `full.md`。文件里有完整的对话时间线，可以帮你恢复记忆。

**如果你记忆清晰，跳过这一步。**

## Part 3 — 输出会话摘要

直接以 YAML frontmatter 开头，不要有任何前导文字。

```
---
slug: <和 Part 1 用的同一个 slug>
title: <短中文标题, <50 字>
summary: <一句话中文描述, <120 字>
---

## 讨论要点
<不只是罗列做了什么。必须包含关键决策和原因。用最适合的格式概括。>

## 关键决策
<如果有决策，每个用以下格式。如果没有决策，写"无"。>
- **决策:** xxx
  - 原因: xxx
  - 考虑过的替代方案: xxx

## 产出物
<具体文件路径 + 变更类型（新建/修改/删除）。如果没有，写"纯讨论，无代码/文件产出"。>

## 待跟进
<编号列表。如果没有，写"无"。>
```

## Part 4 — 填入摘要

把 Part 3 的摘要填入草稿，同时生成全量 (`full.md`) 和精简 (`onlyprompt.md`) 两个版本：

```bash
cat <<'SESSION_EOF' | node ~/.claude/scripts/session-finalize.mjs --fill-summary <Part 1 的文件夹路径>
---
slug: <同 Part 3>
title: <同 Part 3>
summary: <同 Part 3>
---

<同 Part 3 的正文>
SESSION_EOF
```

单引号 heredoc `<<'SESSION_EOF'` 是强制的，防止特殊字符被 shell 展开。脚本会自动在该文件夹下写入 `full.md`（含完整时间线）和 `onlyprompt.md`（仅摘要 + 统计），无需额外操作。

## Part 5 — 确认

Bash 执行完后，用一句话确认，包含文件夹路径并说明已生成 `full.md` 与 `onlyprompt.md`。不要重复输出摘要。不要再调用其他工具。

## 关键规则

- **slug** 必须是 kebab-case ASCII: `[a-z0-9-]+`。不能有空格、中文、下划线。2-5 个词。
- 被禁用的 slug: `done`, `auto`, `fix`, `refactor`, `design`, `plan`, `update`, `change`, `misc`, `temp`, `test`, `notes`, `session`, `tools`, `thing`, `stuff`, `discussion`, `meeting`, `review`, `summary`, `grill`, `grill-me`, `grill-done`, `brainstorm`, `my-brainstorm`, `session-done`, `record`, `session-record`。包含这些词的组合 slug 可以（如 `deploy-plan-review`），但纯用不行。
- Part 3 和 Part 4 的 frontmatter + body 内容必须完全一致。
- 如果脚本返回非零退出码，读取 stderr 错误信息并修正后重试。
- 摘要要忠实反映对话的实际内容，不要编造或美化。重点是记录，不是包装。
