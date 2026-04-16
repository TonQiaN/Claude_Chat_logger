---
description: 开始录制会话。从这里开始的所有用户输入和 Claude 输出都会被记录，直到运行 /session_record_done 时归档保存。
---

你正在开始一个会话录制 session。

**主题:** $ARGUMENTS

---

## 你要做的事

1. 记下当前时间作为录制起点
2. 用一句话确认录制已开始，格式如下：

> 📍 会话录制已开始。主题: **<用户给的主题或"自由讨论">**。结束时敲 `/session_record_done` 归档完整对话。

## 关键规则

- 这个 command 的唯一作用是在 transcript 里留一个时间戳标记，让 `/session_record_done` 知道从哪里开始截取
- 不要改变后续对话的行为方式，正常回答用户的问题和请求
- 不要自动调用 `/session_record_done`，用户会手动调用
- 如果用户没给主题（$ARGUMENTS 为空），用"自由讨论"作为默认主题
