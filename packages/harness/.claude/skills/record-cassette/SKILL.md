---
name: record-cassette
description: Record real Claude CLI sessions as cassette test fixtures. Use when adding new cassette recordings, re-recording stale fixtures after CLI updates, or capturing a new interaction pattern for regression testing.
---

# Record Cassette

Record real Claude CLI sessions as JSONL cassette fixtures for replay-based harness tests.

## When to Use

- Adding a new cassette fixture for a scenario not yet covered
- Re-recording after a Claude CLI version update (output format may have changed)
- User says "record", "cassette", "re-record", or "new fixture"

## Prerequisites

- Claude CLI installed and authenticated (`claude --version`)
- Working directory: agent-ui-harness repo root

## Choosing What to Record

Cassettes should be **representative of real usage**, not toy examples. Before recording, check what real sessions look like:

```bash
# Find large sessions with real tool use
for f in ~/.claude/projects/*/*.jsonl; do
  size=$(wc -c < "$f")
  [ "$size" -gt 50000 ] && echo "$(basename $f): ${size}B"
done | sort -t: -k2 -rn | head -5
```

Use real sessions as templates for recording prompts. A good cassette exercises the same tool chains, content sizes, and event patterns that the harness sees in production.

### Current fixture coverage

Check `test/cassettes/` for what already exists. Key patterns to cover:

| Pattern | Example prompt | Tools needed |
|---|---|---|
| Simple text response | "Say hello in one sentence." | none |
| Single tool round-trip | "Read package.json and tell me the name." | Read |
| Extended thinking | Math/reasoning with `--effort max` | none |
| Multi-tool exploration | "Explain how X works. Read the source." | Read, Grep, Glob |
| Code search | "Find all uses of Y." | Grep, Glob |
| Code modification | "Add a JSDoc to function Z." | Read, Edit |

## Recording

Use the recording script:

```bash
npx tsx scripts/record-cassette.ts <name> "<prompt>" [extra-cli-flags...]
```

### Standard flags

The script automatically adds `--mcp-config '{"mcpServers":{}}' --strict-mcp-config` to keep recordings clean and environment-independent (no MCP servers). Pass additional flags after the prompt:

- **Read-only tasks**: `--allowedTools "Read,Grep,Glob" --dangerously-skip-permissions`
- **Edit tasks**: `--allowedTools "Read,Edit" --dangerously-skip-permissions`
- **Extended thinking**: `--effort max --dangerously-skip-permissions`
- **Bash tasks**: `--allowedTools "Read,Bash" --dangerously-skip-permissions` (use cautiously)

### Examples

```bash
# Simple response
npx tsx scripts/record-cassette.ts simple-response "Say hello in one sentence."

# Multi-tool code exploration
npx tsx scripts/record-cassette.ts code-exploration \
  "Explain how the cassette recording system in src/server/cassette.ts works. Read the relevant source files." \
  --allowedTools "Read,Grep,Glob" --dangerously-skip-permissions

# Extended thinking
npx tsx scripts/record-cassette.ts extended-thinking \
  "What is the 15th Fibonacci number? Show your reasoning." \
  --effort max --dangerously-skip-permissions

# Code edit (revert the edit after!)
npx tsx scripts/record-cassette.ts code-edit \
  "Add a JSDoc comment to the parseCassette function in src/server/cassette.ts." \
  --allowedTools "Read,Edit" --dangerously-skip-permissions
```

## After Recording

### 1. Verify the cassette structure

```bash
cat test/cassettes/<name>.jsonl | python3 -c "
import sys, json
for line in sys.stdin:
    d = json.loads(line)
    if d['type'] == 'stdout':
        inner = json.loads(d['data'])
        blocks = inner.get('message',{}).get('content',[])
        parts = []
        for b in blocks:
            bt = b['type']
            if bt == 'tool_use': parts.append(f'tool_use({b.get(\"name\",\"?\")})')
            elif bt == 'tool_result': parts.append(f'tool_result({len(json.dumps(b.get(\"content\",\"\")))}B)')
            elif bt == 'text': parts.append(f'text({len(b.get(\"text\",\"\"))}ch)')
            elif bt == 'thinking': parts.append(f'thinking({len(b.get(\"thinking\",\"\"))}ch)')
            else: parts.append(bt)
        print(f'  ts={d[\"ts\"]:>6}  {inner[\"type\"]:>16}  {\" + \".join(parts) if parts else \"(empty)\"}')
    else:
        print(f'  {d[\"type\"]} ts={d.get(\"ts\",\"?\")}')
"
```

### 2. Revert any edits

If the recording involved Edit/Write tools:
```bash
git checkout <files-that-were-edited>
```

### 3. Run cassette tests

```bash
npx vitest run test/server/cassette-replay.test.ts
```

## Rules

- **No MCP in recordings.** Always use `--strict-mcp-config` (the script does this automatically). Fixtures must be environment-independent.
- **Revert edits.** If a recording modifies files, restore them immediately after.
- **Don't hand-craft.** The whole point is real CLI output. If you need a specific event shape for a unit test, use FakeAdapter instead.
- **Name descriptively.** The cassette name should describe the interaction pattern, not the prompt content.
