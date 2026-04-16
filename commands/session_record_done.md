---
description: 结束会话录制。把从 /session_record_start 开始的所有用户输入和 Claude 输出归档到 docs/sessions/。
---

你正在结束一个会话录制 session。从最近一次 `/session_record_start` 到现在的所有用户输入和 Claude 输出都要被归档保存。

你的输出 MUST 按以下三个 Part 严格执行，顺序不能乱。

## Part 0 — 回顾对话，确定会话范围

回看本次对话，找到最近一次 `/session_record_start` 的调用位置。从那个点到现在的全部内容就是要归档的范围。

**如果找不到 `/session_record_start`，直接停止。** 输出以下消息后结束，不要执行 Part 1/2/3：

> ⚠️ 未找到 `/session_record_start` 标记，无法归档。请先用 `/session_record_start` 开始录制。

不要回退到 `/my_brainstorm`、`/grill-me` 或其他命令。`/session_record_done` 只与 `/session_record_start` 配对。

## Part 0.5 — 刷新对话记忆

在生成摘要之前，先运行以下命令获取本次录制的完整对话内容：

```bash
node ~/.claude/scripts/session-finalize.mjs --preview
```

阅读输出内容，结合你自己的上下文记忆，确保你对本次对话的内容有完整的了解。这一步在 `/compact` 之后尤其重要，因为你的上下文可能丢失了早期对话。

**不要把 preview 的输出展示给用户。** 这一步是静默执行的，只是为了帮你写出更好的摘要。

## Part 1 — 输出会话摘要

直接以 YAML frontmatter 开头，不要有任何前导文字。

```
---
slug: <kebab-case, 2-5 词, 具体描述这次讨论的内容>
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

## Part 2 — 通过 Bash 归档

Part 1 输出之后，立刻调用 Bash tool，把 Part 1 的内容原样传给 `session-finalize.sh`：

```bash
cat <<'SESSION_EOF' | node ~/.claude/scripts/session-finalize.mjs
---
slug: <同 Part 1>
title: <同 Part 1>
summary: <同 Part 1>
---

<同 Part 1 的正文>
SESSION_EOF
```

单引号 heredoc `<<'SESSION_EOF'` 是强制的，防止特殊字符被 shell 展开。

## Part 3 — 确认

Bash 执行完后，用一句话确认，包含脚本打印的输出路径。不要重复输出摘要。不要再调用其他工具。

## 关键规则

- **slug** 必须是 kebab-case ASCII: `[a-z0-9-]+`。不能有空格、中文、下划线。2-5 个词。
- 被禁用的 slug: `done`, `auto`, `fix`, `refactor`, `design`, `plan`, `update`, `change`, `misc`, `temp`, `test`, `notes`, `session`, `tools`, `thing`, `stuff`, `discussion`, `meeting`, `review`, `summary`, `grill`, `grill-me`, `grill-done`, `brainstorm`, `my-brainstorm`, `session-done`, `record`, `session-record`。包含这些词的组合 slug 可以（如 `deploy-plan-review`），但纯用不行。
- YAML frontmatter block（`---` 行之间）必须是 Part 1 的第一行内容。
- Part 1 和 Part 2 的 frontmatter + body 内容必须完全一致。
- 如果 `session-finalize.mjs` 返回非零退出码（bad slug、no transcript 等），读取 stderr 错误信息并修正后重试 Part 2。
- 摘要要忠实反映对话的实际内容，不要编造或美化。重点是记录，不是包装。
