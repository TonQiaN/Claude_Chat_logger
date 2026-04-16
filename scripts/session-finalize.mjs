#!/usr/bin/env node
// session-finalize.mjs — Node.js rewrite of session-finalize.sh
// Archives Claude Code conversation sessions to Markdown.
//
// Usage (same contract as the bash version):
//   cat <<'EOF' | node ~/.claude/scripts/session-finalize.mjs
//   ---
//   slug: my-session
//   title: Session Title
//   summary: One-line summary.
//   ---
//   ## Body content
//   EOF
//
// Env overrides:
//   SESSION_ARCHIVE_DIR — output dir (default: docs/sessions)
//   GRILL_ARCHIVE_DIR   — legacy alias
//   SESSION_START_FROM  — ISO-8601 override for start time

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';

// ─── Constants ───────────────────────────────────────────────────────────────

const ARCHIVE_DIR = process.env.SESSION_ARCHIVE_DIR
  || process.env.GRILL_ARCHIVE_DIR
  || 'docs/sessions';

const SLUG_BLACKLIST = new Set([
  'done','auto','fix','refactor','design','plan','update','change','misc',
  'temp','test','notes','session','tools','thing','stuff','discussion',
  'meeting','review','summary','grill','grill-me','grill-done','brainstorm',
  'my-brainstorm','session-done','record','session-record',
]);

const SESSION_TYPE_LABELS = {
  session_record: 'Session Record',
  my_brainstorm:  'Brainstorm + Grill Session',
  'grill-me':     'Grill-me Session',
};

const START_COMMANDS = ['/session_record_start', '/my_brainstorm', '/grill-me'];
const START_TYPE_MAP = {
  '/session_record_start': 'session_record',
  '/my_brainstorm': 'my_brainstorm',
  '/grill-me': 'grill-me',
};
const END_COMMANDS = ['/session_record_done', '/session-done', '/grill-done'];

const MERGE_WINDOW_SEC = 60;

// ─── Tool summary extractors ────────────────────────────────────────────────

function toolSummary(name, input) {
  const i = input || {};
  const extractors = {
    Bash:            () => (i.command || '').slice(0, 120),
    Edit:            () => i.file_path || '(unknown file)',
    Write:           () => i.file_path || '(unknown file)',
    Read:            () => i.file_path || '(unknown file)',
    Grep:            () => `${(i.pattern||'').slice(0,80)} in ${i.path||'.'}`,
    Glob:            () => `${(i.pattern||'').slice(0,80)} in ${i.path||'.'}`,
    WebSearch:       () => `"${(i.query||'').slice(0,80)}"`,
    WebFetch:        () => (i.url || '').slice(0, 100),
    Agent:           () => `"${(i.description||'').slice(0,80)}"`,
    AskUserQuestion: () => `"${(i.questions?.[0]?.question||'').slice(0,60)}"`,
    Skill:           () => i.skill || '(unknown)',
    ToolSearch:      () => `"${(i.query||'').slice(0,60)}"`,
  };
  const fn = extractors[name];
  return fn ? fn() : '';
}

function toolDetail(name, input) {
  const i = input || {};
  if (name === 'Bash') {
    const cmd = (i.command || '(no command)').slice(0, 300);
    return `\n\`\`\`bash\n${cmd}\n\`\`\`\n`;
  }
  if (name === 'Edit') {
    const os = (i.old_string || '').slice(0, 100);
    const ns = (i.new_string || '').slice(0, 100);
    return `\nold_string: \`${os}\`\nnew_string: \`${ns}\`\n`;
  }
  if (name === 'Write') return '\n(file created/overwritten)\n';
  if (name === 'Agent') return i.description ? `\n${(i.description||'').slice(0,200)}\n` : '';
  if (name === 'AskUserQuestion') {
    const parts = [];
    for (const q of (i.questions || [])) {
      if (q.question) parts.push(q.question);
      if (q.options) {
        for (const opt of q.options) {
          parts.push(`- **${opt.label}**: ${opt.description || ''}`);
        }
      }
    }
    return parts.length ? `\n${parts.join('\n')}\n` : '';
  }
  return '';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function die(msg) {
  process.stderr.write(`session-finalize: ${msg}\n`);
  process.exit(1);
}

function tsEpoch(iso) {
  return Math.floor(new Date(iso || '1970-01-01T00:00:00Z').getTime() / 1000);
}

function tsLocal(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function sanitizeSlug(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ─── parseStdin ──────────────────────────────────────────────────────────────

function parseStdin(text) {
  if (!text.trim()) die('empty stdin (expected YAML frontmatter summary)');
  const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) die('no YAML frontmatter found in stdin');
  const fields = {};
  for (const line of fmMatch[1].split('\n')) {
    const m = line.match(/^(\w[\w_]*):\s*(.*)$/);
    if (m) fields[m[1]] = m[2].trim();
  }
  return {
    slug: sanitizeSlug(fields.slug || ''),
    title: fields.title || '',
    summary: fields.summary || '',
    specPath: fields.spec_path || '',
    body: fmMatch[2].trim(),
  };
}

// ─── validateSlug ────────────────────────────────────────────────────────────

function validateSlug(slug) {
  if (!slug) die("missing or empty 'slug' in frontmatter");
  if (SLUG_BLACKLIST.has(slug)) {
    die(`slug '${slug}' is too generic. Pick a specific slug (e.g. 'user-profile-page-layout' not '${slug}').`);
  }
}

// ─── findTranscript ──────────────────────────────────────────────────────────

function findTranscript() {
  const key = process.cwd().replace(/[/_]/g, '-');
  const root = join(process.env.HOME, '.claude', 'projects', key);
  if (!existsSync(root)) die(`no transcripts directory at ${root}`);

  const jsonls = readdirSync(root)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ name: f, mtime: statSync(join(root, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!jsonls.length) die(`no .jsonl transcript in ${root}`);
  return join(root, jsonls[0].name);
}

// ─── findBoundary ────────────────────────────────────────────────────────────

function findBoundary(transcriptPath) {
  const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  const events = [];

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'user') continue;
    const content = entry.message?.content;
    if (typeof content !== 'string') continue;

    const cmdMatch = content.match(/<command-name>\/([^<]+)<\/command-name>/);
    if (!cmdMatch) continue;
    const cmd = '/' + cmdMatch[1];
    const ts = tsEpoch(entry.timestamp);

    if (START_COMMANDS.includes(cmd)) {
      events.push({ kind: 'start', type: START_TYPE_MAP[cmd], ts, rawTs: entry.timestamp });
    } else if (END_COMMANDS.includes(cmd)) {
      events.push({ kind: 'end', ts, rawTs: entry.timestamp });
    }
  }

  events.sort((a, b) => a.ts - b.ts);
  const ends = events.filter(e => e.kind === 'end');
  const prevEnd = ends.length >= 2 ? ends[ends.length - 2].ts : 0;

  const overrideTs = process.env.SESSION_START_FROM
    ? tsEpoch(process.env.SESSION_START_FROM) : 0;
  const floor = Math.max(prevEnd, overrideTs);

  const chosen = events.find(e => e.kind === 'start' && e.ts > floor);
  const lastEnd = ends.length ? ends[ends.length - 1] : null;

  if (!chosen) die('no /session_record_start, /grill-me, or /my_brainstorm command found');

  return {
    startTs: chosen.ts,
    endTs: lastEnd ? lastEnd.ts : 0,
    sessionType: chosen.type,
  };
}

// ─── extractMessages ─────────────────────────────────────────────────────────

function extractMessages(transcriptPath, startTs, endTs) {
  const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  const messages = [];

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    if (entry.isMeta) continue;

    const ts = tsEpoch(entry.timestamp);
    if (ts < startTs) continue;
    if (endTs > 0 && ts >= endTs) continue;

    if (entry.type === 'user') {
      const content = entry.message?.content;

      // Handle tool_result messages (array content with tool results)
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && messages.length > 0) {
            const resultText = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map(c => c.text || '').join('\n')
                : '';
            if (!resultText || !block.tool_use_id) continue;
            // Walk backward to find the matching tool_use
            for (let j = messages.length - 1; j >= 0; j--) {
              if (messages[j].type !== 'assistant') continue;
              const tc = messages[j].toolCalls.find(t => t.id === block.tool_use_id);
              if (tc) { tc.result = resultText; break; }
            }
          }
        }
        continue;
      }

      if (typeof content !== 'string') continue;

      const isCommand = content.startsWith('<command-') || content.startsWith('<local-command');
      let commandName = null, commandArgs = null;
      if (isCommand) {
        const cmdM = content.match(/<command-name>\/([^<]+)<\/command-name>/);
        if (cmdM) commandName = cmdM[1];
        const argsM = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
        if (argsM) commandArgs = argsM[1].trim();
      }

      messages.push({
        type: 'user',
        timestamp: entry.timestamp,
        ts,
        localTime: tsLocal(entry.timestamp),
        text: isCommand ? null : content,
        toolCalls: [],
        isCommand,
        commandName,
        commandArgs,
      });
    } else {
      // assistant
      const contentArr = entry.message?.content;
      if (!Array.isArray(contentArr)) continue;

      const textParts = contentArr
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text);
      const text = textParts.join('\n\n') || null;

      const toolCalls = contentArr
        .filter(b => b.type === 'tool_use')
        .map(b => ({
          id: b.id || null,
          name: b.name || 'Unknown',
          summary: toolSummary(b.name, b.input),
          detail: toolDetail(b.name, b.input),
          result: null,
        }));

      messages.push({
        type: 'assistant',
        timestamp: entry.timestamp,
        ts,
        localTime: tsLocal(entry.timestamp),
        text,
        toolCalls,
        isCommand: false,
        commandName: null,
        commandArgs: null,
      });
    }
  }

  return messages;
}

// ─── mergeMessages → turns ───────────────────────────────────────────────────

function buildTurns(messages) {
  // Find the opener (the start command message)
  const opener = messages.find(m => m.isCommand && START_COMMANDS.some(
    c => c === '/' + m.commandName
  ));

  // Filter out command messages for the timeline
  const timeline = messages.filter(m => !m.isCommand);

  const turns = [];
  let turnNum = 0;

  // Add opener as turn 0 if it exists
  if (opener) {
    turns.push({
      turnNumber: 0,
      role: 'opener',
      localTime: opener.localTime,
      text: opener.commandArgs || '*(录制开始)*',
      commandName: opener.commandName,
      toolCalls: [],
      anchorId: 'turn-0',
    });
  }

  let i = 0;
  while (i < timeline.length) {
    const msg = timeline[i];

    if (msg.type === 'user') {
      turnNum++;
      turns.push({
        turnNumber: turnNum,
        role: 'user',
        localTime: msg.localTime,
        text: msg.text,
        toolCalls: [],
        anchorId: `turn-${turnNum}`,
      });
      i++;
    } else {
      // assistant — merge ALL consecutive assistant messages (user msg is the boundary)
      turnNum = turns.length > 0 && turns[turns.length - 1].role === 'user'
        ? turns[turns.length - 1].turnNumber
        : turnNum;

      const merged = {
        turnNumber: turnNum || 1,
        role: 'claude',
        localTime: msg.localTime,
        text: '',
        toolCalls: [],
        anchorId: `turn-${turnNum || 1}`,
      };

      while (i < timeline.length && timeline[i].type === 'assistant') {
        const cur = timeline[i];
        if (cur.text) {
          merged.text = merged.text ? merged.text + '\n\n' + cur.text : cur.text;
        }
        merged.toolCalls.push(...cur.toolCalls);
        merged.localTime = cur.localTime;
        i++;
      }

      if (!merged.text) merged.text = null;
      turns.push(merged);
    }
  }

  return turns;
}

// ─── renderTimeline ──────────────────────────────────────────────────────────

function parseAskUserResult(resultText) {
  const m = resultText.match(/User has answered your questions:\s*([\s\S]*?)(?:\.\s*You can now continue|$)/);
  if (!m) return null;
  const pairs = [];
  const pairRe = /"([^"]+)"="([^"]+)"/g;
  let pm;
  while ((pm = pairRe.exec(m[1])) !== null) {
    pairs.push({ question: pm[1], answer: pm[2] });
  }
  const notesM = m[1].match(/user notes:\s*(.+)/);
  return { pairs, notes: notesM ? notesM[1].trim() : null };
}

function renderToolCall(tc) {
  const summaryText = tc.summary ? `${tc.name}: ${tc.summary}` : tc.name;
  let body = tc.detail || '';
  let after = '';

  if (tc.name === 'AskUserQuestion' && tc.result) {
    const parsed = parseAskUserResult(tc.result);
    if (parsed && parsed.pairs.length) {
      after = parsed.pairs.map(p =>
        `\n> **🧑 选择:** ${p.answer}` + (parsed.notes ? ` *(备注: ${parsed.notes})*` : '')
      ).join('\n');
    } else {
      after = `\n> **🧑 选择:** ${tc.result.slice(0, 200)}`;
    }
  } else if (tc.result) {
    body += `\n**Result:** ${tc.result.slice(0, 300)}\n`;
  }

  return `\n<details>\n<summary>🔧 ${summaryText}</summary>\n${body}\n</details>\n${after}`;
}

function renderTurn(turn) {
  if (turn.role === 'opener') {
    const cmd = turn.commandName || 'unknown';
    return [
      '\n---\n',
      `<a id="${turn.anchorId}"></a>`,
      `### 🧑 用户 \`${turn.localTime}\` (/${cmd})\n`,
      `> ${turn.text.replace(/\n/g, '\n> ')}\n`,
      '---\n',
    ].join('\n');
  }

  if (turn.role === 'user') {
    return [
      '\n---\n',
      `<a id="${turn.anchorId}"></a>`,
      `### 🧑 用户 \`${turn.localTime}\` (#${turn.turnNumber})\n`,
      `> ${(turn.text || '').replace(/\n/g, '\n> ')}\n`,
      '---\n',
    ].join('\n');
  }

  // claude
  const parts = [`\n### 🤖 Claude \`${turn.localTime}\` (#${turn.turnNumber})\n`];

  if (turn.toolCalls.length) {
    parts.push(turn.toolCalls.map(renderToolCall).join(''));
  }
  if (turn.text) {
    parts.push(turn.text + '\n');
  }

  return parts.join('\n');
}

function renderTimeline(turns) {
  return turns.map(renderTurn).join('');
}

// ─── generateTOC ─────────────────────────────────────────────────────────────

function generateTOC(turns) {
  const userTurns = turns.filter(t => t.role === 'user');
  if (userTurns.length === 0) return '';

  const lines = userTurns.map(t => {
    const preview = (t.text || '').replace(/\n/g, ' ').slice(0, 40);
    return `> ${t.turnNumber}. [${preview}](#${t.anchorId}) \`${t.localTime}\``;
  });

  return `\n> **目录**\n${lines.join('\n')}\n`;
}

// ─── computeStats ────────────────────────────────────────────────────────────

function computeStats(messages, turns) {
  const userMsgs = messages.filter(m => m.type === 'user' && !m.isCommand);
  const assistantMsgs = messages.filter(m => m.type === 'assistant');
  const claudeTurns = turns.filter(t => t.role === 'claude');
  const userTurns = turns.filter(t => t.role === 'user');

  const allMsgs = messages.filter(m => !m.isCommand);
  const firstTs = allMsgs.length ? allMsgs[0].ts : 0;
  const lastTs = allMsgs.length ? allMsgs[allMsgs.length - 1].ts : 0;
  const durMin = Math.floor((lastTs - firstTs) / 60);
  const durStr = durMin < 1 ? '< 1 min' : `${durMin} min`;
  const tStart = allMsgs.length ? allMsgs[0].localTime : '??:??';
  const tEnd = allMsgs.length ? allMsgs[allMsgs.length - 1].localTime : '??:??';

  // Tool counts
  const toolMap = {};
  for (const m of assistantMsgs) {
    for (const tc of m.toolCalls) {
      toolMap[tc.name] = (toolMap[tc.name] || 0) + 1;
    }
  }
  const toolGroups = Object.entries(toolMap)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} (${count})`);
  const toolsStr = toolGroups.length ? toolGroups.join(', ') : 'none';

  // Files touched
  const files = new Set();
  for (const m of assistantMsgs) {
    for (const tc of m.toolCalls) {
      if (['Edit','Write','Read'].includes(tc.name) && tc.summary && tc.summary !== '(unknown file)') {
        files.add(tc.summary);
      }
    }
  }

  const mergedNote = assistantMsgs.length !== claudeTurns.length
    ? ` (merged into ${claudeTurns.length} turns)`
    : '';

  return [
    '\n---\n',
    '📊 **Session Stats**',
    `- Duration: ${durStr} (${tStart} – ${tEnd})`,
    `- Turns: ${userTurns.length}`,
    `- User messages: ${userMsgs.length}`,
    `- Claude responses: ${assistantMsgs.length}${mergedNote}`,
    `- Tools used: ${toolsStr}`,
    `- Files touched: ${files.size}`,
    '',
  ].join('\n');
}

// ─── writeOutput ─────────────────────────────────────────────────────────────

function writeOutput({ sessionType, slug, title, summary, specPath, summaryBody, toc, timeline, stats }) {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const dateStamp = new Date().toISOString().slice(0, 10);
  const projectName = basename(process.cwd()).replace(/[^A-Za-z0-9_.-]/g, '-');
  const headerLabel = SESSION_TYPE_LABELS[sessionType] || 'Session Record';

  // Collision handling
  let outfile = join(ARCHIVE_DIR, `${dateStamp}-${slug}.md`);
  let n = 2;
  while (existsSync(outfile)) {
    outfile = join(ARCHIVE_DIR, `${dateStamp}-${slug}-${n}.md`);
    n++;
  }

  // Build file content
  const header = [
    `# ${headerLabel}: ${dateStamp}`,
    '',
    `**Project:** \`${projectName}\``,
    `**Working dir:** \`${process.cwd()}\``,
    `**Session type:** \`${sessionType}\``,
    `**Slug:** \`${slug}\``,
  ];
  if (title) header.push(`**Title:** ${title}`);
  if (summary) header.push(`**Summary:** ${summary}`);
  if (specPath) header.push(`**Spec doc:** \`${specPath}\``);

  const content = [
    header.join('\n'),
    '',
    '---',
    '',
    '# 📋 会议总结',
    '',
    summaryBody,
    '',
    '---',
    '',
    '# 📜 完整讨论时间线',
    toc,
    timeline,
    stats,
  ].join('\n');

  writeFileSync(outfile, content);

  // Update INDEX.md
  const indexPath = join(ARCHIVE_DIR, 'INDEX.md');
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, [
      '# 设计讨论 Session 归档索引',
      '',
      '| 日期 | 类型 | Slug | 主题 | 一句话摘要 | Spec | 文件 |',
      '|---|---|---|---|---|---|---|',
      '',
    ].join('\n'));
  }
  const filename = basename(outfile);
  const row = `| ${dateStamp} | ${sessionType} | ${slug} | ${title || '—'} | ${summary || '—'} | ${specPath || '—'} | [${filename}](${filename}) |\n`;
  writeFileSync(indexPath, readFileSync(indexPath, 'utf8') + row);

  return outfile;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  // Read stdin
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const stdinText = Buffer.concat(chunks).toString('utf8');

  const { slug, title, summary, specPath, body } = parseStdin(stdinText);
  validateSlug(slug);

  const transcriptPath = findTranscript();
  const { startTs, endTs, sessionType } = findBoundary(transcriptPath);
  const messages = extractMessages(transcriptPath, startTs, endTs);

  if (!messages.some(m => !m.isCommand)) {
    die('empty timeline body (no messages since session start)');
  }

  const turns = buildTurns(messages);
  const toc = generateTOC(turns);
  const timeline = renderTimeline(turns);
  const stats = computeStats(messages, turns);

  const outfile = writeOutput({
    sessionType, slug, title, summary, specPath,
    summaryBody: body,
    toc, timeline, stats,
  });

  console.log(`session-finalize: wrote ${outfile}`);
}

main().catch(err => {
  die(err.message);
});
