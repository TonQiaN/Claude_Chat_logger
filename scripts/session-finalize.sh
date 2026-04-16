#!/bin/bash
# session-finalize.sh — archive a design-discussion session to docs/sessions/.
#
# Supports three session types, detected by scanning the transcript for the
# most recent slash-command invocation of either:
#   - /session_record_start → general-purpose conversation recording
#   - /grill-me             → decision-tree interrogation sessions
#   - /my_brainstorm        → brainstorm + optional grill + spec-revision sessions
#
# Called from the /session_record_done or /session-done command as:
#   cat <<'EOF' | bash ~/.claude/scripts/session-finalize.sh
#   <frontmatter summary>
#   EOF
#
# Reads a YAML-frontmatter summary from stdin, then:
#   1. Locates the current session's transcript (most recently modified
#      .jsonl in ~/.claude/projects/<project_dir>/).
#   2. Scans the transcript backward for the most recent /grill-me or
#      /my_brainstorm command invocation to find the discussion start.
#   3. Extracts the timeline (user + assistant text) from that point on.
#   4. Writes docs/sessions/${date}-${slug}.md (with -2, -3 suffix on
#      collision). Summary first, full timeline second.
#   5. Updates docs/sessions/INDEX.md.
#
# Stateless: no /tmp markers, no hooks, works across context compaction
# because the transcript .jsonl is append-only on disk.
#
# Exit codes:
#   0 — success (prints output path to stdout)
#   1 — bad input, bad slug, no transcript, or empty timeline (error on stderr)
#
# Env overrides:
#   SESSION_ARCHIVE_DIR — override output dir (default: docs/sessions)
#   GRILL_ARCHIVE_DIR   — legacy alias for SESSION_ARCHIVE_DIR

set -euo pipefail

SESSION_ARCHIVE_DIR="${SESSION_ARCHIVE_DIR:-${GRILL_ARCHIVE_DIR:-docs/sessions}}"

# Exact-match blacklist of too-generic slugs. Forces Claude to pick
# descriptive names. Compound slugs containing these as parts are fine
# (e.g. "deploy-plan-review" is ok; bare "plan" is not).
SLUG_BLACKLIST=(
  done auto fix refactor design plan update change misc temp test
  notes session tools thing stuff discussion meeting review summary
  grill grill-me grill-done brainstorm my-brainstorm session-done
  record session-record
)

die() {
  echo "session-finalize: $*" >&2
  exit 1
}

# === Read frontmatter summary from stdin ===
SUMMARY=$(cat)
[ -n "$SUMMARY" ] || die "empty stdin (expected YAML frontmatter summary)"

parse_field() {
  local field="$1"
  printf '%s\n' "$SUMMARY" | awk -v key="$field" '
    BEGIN { in_fm=0; done=0 }
    /^---[[:space:]]*$/ {
      if (!done) { in_fm = !in_fm; if (!in_fm) done=1 }
      next
    }
    in_fm && !done {
      if (match($0, "^" key ":[[:space:]]*")) {
        val = substr($0, RLENGTH+1)
        sub(/[[:space:]]+$/, "", val)
        print val
        exit
      }
    }
  '
}

strip_frontmatter() {
  printf '%s\n' "$SUMMARY" | awk '
    BEGIN { in_fm=0; past_fm=0 }
    /^---[[:space:]]*$/ {
      if (!past_fm) {
        in_fm = !in_fm
        if (!in_fm) past_fm=1
        next
      }
    }
    past_fm { print }
  '
}

SLUG_RAW=$(parse_field "slug")
TITLE=$(parse_field "title")
SUMMARY_LINE=$(parse_field "summary")
SPEC_PATH=$(parse_field "spec_path")
SUMMARY_BODY=$(strip_frontmatter)

# Sanitize slug: lowercase ASCII, collapse non-[a-z0-9-] to dashes, trim dashes.
SLUG=$(printf '%s' "$SLUG_RAW" \
  | tr '[:upper:]' '[:lower:]' \
  | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-*//; s/-*$//')

[ -n "$SLUG" ] || die "missing or empty 'slug' in frontmatter"

for banned in "${SLUG_BLACKLIST[@]}"; do
  if [ "$SLUG" = "$banned" ]; then
    die "slug '$SLUG' is too generic. Pick a specific slug that identifies this discussion (e.g. 'user-profile-page-layout' not '$banned')."
  fi
done

# === Locate transcript ===
PROJECT_DIR_KEY=$(pwd | sed 's/[\/_]/-/g')
PROJECTS_ROOT="$HOME/.claude/projects/${PROJECT_DIR_KEY}"

[ -d "$PROJECTS_ROOT" ] || die "no transcripts directory at $PROJECTS_ROOT"

# Most recently modified jsonl = the session we are currently in.
TRANSCRIPT=$(ls -t "$PROJECTS_ROOT"/*.jsonl 2>/dev/null | head -1)
[ -n "${TRANSCRIPT:-}" ] && [ -f "$TRANSCRIPT" ] || die "no .jsonl transcript in $PROJECTS_ROOT"

# === Find start_ts and session type ===
# Strategy: pick the EARLIEST starter in the transcript that comes AFTER the
# most recent prior finalization (if any).
#
# For multi-session transcripts (finalize A, start B in same file), the
# second-to-last end event is treated as a session boundary — only starters
# AFTER it are considered. No time threshold: even rapid consecutive
# sessions are correctly separated.
#
# Manual override: set SESSION_START_FROM=<ISO-8601 timestamp> to force a
# specific start time.
START_LINE=$(jq -sr --arg override "${SESSION_START_FROM:-}" '
  def ts_epoch: (. // "1970-01-01T00:00:00Z") | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
  ([ .[]
     | select(.type == "user")
     | select(.message.content | type == "string")
     | . as $msg
     | if ($msg.message.content | contains("<command-name>/session_record_start</command-name>")) then
         {kind: "start", type: "session_record", ts: ($msg.timestamp | ts_epoch)}
       elif ($msg.message.content | contains("<command-name>/my_brainstorm</command-name>")) then
         {kind: "start", type: "my_brainstorm", ts: ($msg.timestamp | ts_epoch)}
       elif ($msg.message.content | contains("<command-name>/grill-me</command-name>")) then
         {kind: "start", type: "grill-me", ts: ($msg.timestamp | ts_epoch)}
       elif ($msg.message.content | contains("<command-name>/session_record_done</command-name>")
             or ($msg.message.content | contains("<command-name>/session-done</command-name>"))
             or ($msg.message.content | contains("<command-name>/grill-done</command-name>"))) then
         {kind: "end", ts: ($msg.timestamp | ts_epoch)}
       else empty end
  ] | sort_by(.ts)) as $events
  | ($events | map(select(.kind == "end"))) as $ends
  | (($ends | length) as $n
     | if $n >= 2 then
         ($ends[-2].ts)
       else 0
       end) as $prev_end
  | (if $override != ""
       then ($override | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)
       else 0
     end) as $override_ts
  | ([$prev_end, $override_ts] | max) as $floor
  | ($events
      | map(select(.kind == "start" and (.ts > $floor)))
      | first) as $chosen
  | ($events | map(select(.kind == "end")) | last // null) as $end_event
  | if $chosen == null then ""
    else "\($chosen.type) \($chosen.ts) \($end_event.ts // 0)"
    end
' "$TRANSCRIPT" 2>/dev/null || true)

[ -n "$START_LINE" ] || die "no /session_record_start, /grill-me, or /my_brainstorm command found in transcript $TRANSCRIPT"

SESSION_TYPE=$(printf '%s' "$START_LINE" | awk '{print $1}')
START_TS=$(printf '%s' "$START_LINE" | awk '{print $2}')
END_TS=$(printf '%s' "$START_LINE" | awk '{print $3}')

[ -n "$START_TS" ] || die "failed to parse start timestamp from '$START_LINE'"

# === Extract session opener from command-args ===
# The start message is the raw /session_record_start, /my_brainstorm, or
# /grill-me invocation, which the body extraction below drops because its
# content starts with <command-…>. That loses the user's original topic.
# Pull command-args from the start message and inject it as an opener entry
# so readers see the invoking intent.
OPENER=$(jq -r --argjson start "$START_TS" '
  def ts_epoch: (. // "1970-01-01T00:00:00Z") | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
  def ts_hhmm: ts_epoch | strflocaltime("%H:%M");
  select(.type == "user")
  | select((.message.content | type) == "string")
  | select((.timestamp | ts_epoch) == $start)
  | (.message.content
     | try capture("<command-name>/(?<cmd>[^<]+)</command-name>"; "s")
       catch null) as $cmd_m
  | (.message.content
     | try capture("<command-args>(?<args>.*?)</command-args>"; "s")
       catch null) as $args_m
  | ($cmd_m.cmd // "unknown") as $cmd
  | (($args_m.args // "") | gsub("^\\s+|\\s+$"; "")) as $args
  | ((.timestamp | ts_hhmm) as $t
     | if $args != "" then
         "\n---\n\n### 🧑 用户 `\($t)` (/\($cmd))\n\n> \($args | gsub("\n"; "\n> "))\n\n---\n"
       else
         "\n---\n\n### 🧑 用户 `\($t)` (/\($cmd))\n\n> *(录制开始)*\n\n---\n"
       end)
' "$TRANSCRIPT" 2>/dev/null || true)

# === Extract timeline body ===
BODY=$(jq -r --argjson start "$START_TS" --argjson end "${END_TS:-0}" '
  def ts_epoch: (. // "1970-01-01T00:00:00Z") | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
  def ts_hhmm: ts_epoch | strflocaltime("%H:%M");
  select(.type == "user" or .type == "assistant")
  | select((.timestamp | ts_epoch) >= $start)
  | select($end == 0 or (.timestamp | ts_epoch) < $end)
  | select(.isMeta != true)
  | if .type == "user" then
      if (.message.content | type) == "string"
         and ((.message.content | startswith("<command-")) | not)
         and ((.message.content | startswith("<local-command")) | not)
      then
        ((.timestamp | ts_hhmm) as $t
         | "\n---\n\n### 🧑 用户 `\($t)`\n\n> \(.message.content | gsub("\n"; "\n> "))\n\n---\n")
      else empty end
    elif .type == "assistant" then
      (if (.message.content | type) == "array" then
        ((.message.content | map(select(.type=="text") | .text) | join("\n\n")) as $text
         | (.message.content | map(select(.type=="tool_use")
             | (.name) as $tn
             | (.input.file_path // .input.path // null) as $fp
             | (.input.command // null) as $cm
             | (.input.pattern // null) as $pa
             | (.input.old_string // null) as $os
             | (.input.new_string // null) as $ns
             | if $tn == "Bash" then
                 "\n<details>\n<summary>🔧 \($tn): \(($cm // "") | .[0:120])</summary>\n\n```bash\n\(($cm // "(no command)") | .[0:300])\n```\n\n</details>\n"
               elif $tn == "Edit" then
                 "\n<details>\n<summary>🔧 \($tn): \($fp // "(unknown file)")</summary>\n\nold_string: `\(($os // "") | .[0:100])`\nnew_string: `\(($ns // "") | .[0:100])`\n\n</details>\n"
               elif $tn == "Write" then
                 "\n<details>\n<summary>🔧 \($tn): \($fp // "(unknown file)")</summary>\n\n(file created/overwritten)\n\n</details>\n"
               elif $tn == "Read" then
                 "\n<details>\n<summary>🔧 \($tn): \($fp // "(unknown file)")</summary>\n</details>\n"
               elif $tn == "Grep" or $tn == "Glob" then
                 "\n<details>\n<summary>🔧 \($tn): \(($pa // "") | .[0:80]) in \($fp // ".")</summary>\n</details>\n"
               elif $fp != null then
                 "\n<details>\n<summary>🔧 \($tn): \($fp)</summary>\n</details>\n"
               else
                 "\n<details>\n<summary>🔧 \($tn)</summary>\n</details>\n"
               end
           ) | join("")) as $tools
         | if ($text != "") or ($tools != "") then
             ((.timestamp | ts_hhmm) as $t
              | "\n### 🤖 Claude `\($t)`\n\n\($text)\n\($tools)")
           else empty end)
      else empty end)
    else empty end
' "$TRANSCRIPT" 2>/dev/null || true)

[ -n "$BODY" ] || die "empty timeline body (no messages since session start)"

# === Compute session stats ===
STATS=$(jq -sr --argjson start "$START_TS" --argjson end "${END_TS:-0}" '
  def ts_epoch: (. // "1970-01-01T00:00:00Z") | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
  def ts_hhmm: ts_epoch | strflocaltime("%H:%M");
  [.[]
   | select(.type == "user" or .type == "assistant")
   | select((.timestamp | ts_epoch) >= $start)
   | select($end == 0 or (.timestamp | ts_epoch) < $end)
   | select(.isMeta != true)
  ] as $msgs
  | ($msgs | map(select(.type == "user")) | length) as $user_count
  | ($msgs | map(select(.type == "assistant")) | length) as $asst_count
  | ([$msgs[0].timestamp, $msgs[-1].timestamp]
     | map(ts_epoch) | (.[1] - .[0]) / 60 | floor) as $dur_min
  | ($msgs[0].timestamp | ts_hhmm) as $t_start
  | ($msgs[-1].timestamp | ts_hhmm) as $t_end
  | ([($msgs[] | select(.type == "assistant")
       | .message.content[]? | select(.type == "tool_use")
       | .name)] | group_by(.) | map({name: .[0], count: length})
     | sort_by(-.count)) as $tool_groups
  | ([($msgs[] | select(.type == "assistant")
       | .message.content[]? | select(.type == "tool_use")
       | .input.file_path // empty)] | unique | length) as $file_count
  | (if $dur_min < 1 then "< 1 min"
     else "\($dur_min) min"
     end) as $dur_str
  | (if ($tool_groups | length) == 0 then "none"
     else ($tool_groups | map("\(.name) (\(.count))") | join(", "))
     end) as $tools_str
  | "\n---\n\n📊 **Session Stats**\n- Duration: \($dur_str) (\($t_start) – \($t_end))\n- User messages: \($user_count)\n- Claude responses: \($asst_count)\n- Tools used: \($tools_str)\n- Files touched: \($file_count)\n"
' "$TRANSCRIPT" 2>/dev/null || true)

# === Build output file path with collision handling ===
mkdir -p "$SESSION_ARCHIVE_DIR"
DATE_STAMP=$(date +%Y-%m-%d)
PROJECT_NAME=$(basename "$(pwd)" | sed 's/[^A-Za-z0-9_.-]/-/g')

OUTFILE="$SESSION_ARCHIVE_DIR/${DATE_STAMP}-${SLUG}.md"
N=2
while [ -e "$OUTFILE" ]; do
  OUTFILE="$SESSION_ARCHIVE_DIR/${DATE_STAMP}-${SLUG}-${N}.md"
  N=$((N + 1))
done

# === Write archive file (summary first, timeline second) ===
case "$SESSION_TYPE" in
  session_record) HEADER_LABEL="Session Record" ;;
  my_brainstorm)  HEADER_LABEL="Brainstorm + Grill Session" ;;
  grill-me)       HEADER_LABEL="Grill-me Session" ;;
  *)              HEADER_LABEL="Session Record" ;;
esac

{
  echo "# ${HEADER_LABEL}: ${DATE_STAMP}"
  echo ""
  echo "**Project:** \`${PROJECT_NAME}\`"
  echo "**Working dir:** \`$(pwd)\`"
  echo "**Session type:** \`${SESSION_TYPE}\`"
  echo "**Slug:** \`${SLUG}\`"
  [ -n "$TITLE" ] && echo "**Title:** ${TITLE}"
  [ -n "$SUMMARY_LINE" ] && echo "**Summary:** ${SUMMARY_LINE}"
  [ -n "$SPEC_PATH" ] && echo "**Spec doc:** \`${SPEC_PATH}\`"
  echo ""
  echo "---"
  echo ""
  echo "# 📋 会议总结"
  echo ""
  printf '%s\n' "$SUMMARY_BODY"
  echo ""
  echo "---"
  echo ""
  echo "# 📜 完整讨论时间线"
  [ -n "$OPENER" ] && printf '%s\n' "$OPENER"
  printf '%s\n' "$BODY"
  [ -n "$STATS" ] && printf '%s\n' "$STATS"
} > "$OUTFILE"

# === Update INDEX.md ===
INDEX="$SESSION_ARCHIVE_DIR/INDEX.md"
FILENAME=$(basename "$OUTFILE")
if [ ! -f "$INDEX" ]; then
  cat > "$INDEX" <<'HEAD'
# 设计讨论 Session 归档索引

| 日期 | 类型 | Slug | 主题 | 一句话摘要 | Spec | 文件 |
|---|---|---|---|---|---|---|
HEAD
fi
printf '| %s | %s | %s | %s | %s | %s | [%s](%s) |\n' \
  "$DATE_STAMP" \
  "$SESSION_TYPE" \
  "$SLUG" \
  "${TITLE:-—}" \
  "${SUMMARY_LINE:-—}" \
  "${SPEC_PATH:-—}" \
  "$FILENAME" \
  "$FILENAME" >> "$INDEX"

echo "session-finalize: wrote $OUTFILE"
