import { describe, it, expect } from 'vitest'
import { normalizeClaude, isIgnoredClaudeEvent } from '../../src/server/normalize-claude.js'
import {
  INIT_EVENT,
  SYSTEM_NON_INIT,
  TEXT_ASSISTANT,
  THINKING_ASSISTANT,
  TOOL_USE_ASSISTANT,
  TOOL_RESULT_USER,
  RESULT_SUCCESS,
  RESULT_ERROR,
  TASK_STARTED,
  TASK_UPDATED,
  TASK_NOTIFICATION,
  THINKING_TOKENS,
} from '../helpers/fixtures.js'

describe('normalizeClaude', () => {
  describe('system events', () => {
    it('normalizes init event to run:ready', () => {
      const result = normalizeClaude(INIT_EVENT)
      expect(result).toMatchObject({
        type: 'run:ready',
        data: {
          resumeId: 'abc-123',
          model: 'claude-opus-4-20250514',
          tools: ['Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write'],
          cwd: '/Users/test/project',
        },
      })
      // Verify additive fields are extracted (not just ignored)
      const data = result!.data as Record<string, unknown>
      expect(data.mcpServers).toEqual([{ name: 'chrome-devtools', status: 'connected' }])
      expect(data.permissionMode).toBe('default')
    })

    it('keeps the capabilities init advertises, for a server that takes the process over later', () => {
      const result = normalizeClaude({ ...INIT_EVENT, capabilities: ['msg_lifecycle_v1'] })
      expect((result!.data as Record<string, unknown>).capabilities).toEqual(['msg_lifecycle_v1'])
    })

    it('returns null for non-init system events', () => {
      expect(normalizeClaude(SYSTEM_NON_INIT)).toBeNull()
    })

    it('normalizes compact_boundary to an enriched compact turn:end', () => {
      const result = normalizeClaude({
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 'abc-123',
        uuid: 'test-uuid',
        compact_metadata: {
          trigger: 'manual',
          pre_tokens: 161300,
          post_tokens: 14949,
          duration_ms: 133891,
          cost_usd: 5.21,
        },
      })
      expect(result).toEqual({
        type: 'turn:end',
        data: {
          compact: true,
          trigger: 'manual',
          preTokens: 161300,
          postTokens: 14949,
          durationMs: 133891,
          costUsd: 5.21,
        },
      })
    })

    it('accepts persisted camelCase compact metadata without provider-specific fields', () => {
      expect(normalizeClaude({
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: {
          trigger: 'auto',
          preTokens: 528914,
          postTokens: 14949,
          durationMs: 133891,
          cumulativeDroppedTokens: 513965,
          preservedSegment: { headUuid: 'provider-detail' },
        },
      })).toEqual({
        type: 'turn:end',
        data: {
          compact: true,
          trigger: 'auto',
          preTokens: 528914,
          postTokens: 14949,
          durationMs: 133891,
        },
      })
    })

    it('normalizes compacting status to a started context lifecycle event', () => {
      expect(normalizeClaude({
        type: 'system',
        subtype: 'status',
        status: 'compacting',
      })).toEqual({
        type: 'context:compaction',
        data: { phase: 'started' },
      })
    })

    it('normalizes successful compact result to a completed context lifecycle event', () => {
      expect(normalizeClaude({
        type: 'system',
        subtype: 'status',
        status: null,
        compact_result: 'success',
      })).toEqual({
        type: 'context:compaction',
        data: { phase: 'completed', result: 'success' },
      })
    })

    it('normalizes a non-success compact result to a failed lifecycle event', () => {
      expect(normalizeClaude({
        type: 'system',
        subtype: 'status',
        status: null,
        compact_result: 'error',
        error: { message: 'Compaction request failed' },
      })).toEqual({
        type: 'context:compaction',
        data: {
          phase: 'failed',
          result: 'error',
          error: 'Compaction request failed',
        },
      })
    })

    it('returns null for unrelated system status events', () => {
      expect(normalizeClaude({
        type: 'system',
        subtype: 'status',
        status: 'permission_pending',
      })).toBeNull()
    })

    it('normalizes task_started to task:started', () => {
      const result = normalizeClaude(TASK_STARTED)
      expect(result).toEqual({
        type: 'task:started',
        data: {
          taskId: 'be1rswj0x',
          toolUseId: 'toolu_013LzW8nUUnXz34UWr7gNyFb',
          description: 'Run 5-step loop with 1s delays in background',
          taskType: 'local_bash',
        },
      })
    })

    it('normalizes task_updated to task:updated', () => {
      const result = normalizeClaude(TASK_UPDATED)
      expect(result).toEqual({
        type: 'task:updated',
        data: {
          taskId: 'be1rswj0x',
          patch: { status: 'completed', end_time: 1775924153771 },
        },
      })
    })

    it('normalizes task_notification to task:notification', () => {
      const result = normalizeClaude(TASK_NOTIFICATION)
      expect(result).toEqual({
        type: 'task:notification',
        data: {
          taskId: 'be1rswj0x',
        },
      })
    })

    it('returns null for thinking_tokens', () => {
      expect(normalizeClaude(THINKING_TOKENS)).toBeNull()
    })
  })

  describe('isIgnoredClaudeEvent', () => {
    it('reports thinking_tokens as a deliberate drop', () => {
      expect(isIgnoredClaudeEvent(THINKING_TOKENS)).toBe(true)
    })

    it('does not claim unrecognised system subtypes', () => {
      expect(isIgnoredClaudeEvent(SYSTEM_NON_INIT)).toBe(false)
    })

    it('reports hook chatter, task progress and rate-limit info as deliberate drops', () => {
      expect(isIgnoredClaudeEvent({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' })).toBe(true)
      expect(isIgnoredClaudeEvent({ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart' })).toBe(true)
      expect(isIgnoredClaudeEvent({ type: 'system', subtype: 'task_progress', task_id: 'abc' })).toBe(true)
      expect(isIgnoredClaudeEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toBe(true)
    })

    it('reports a mid-session command-list refresh as a deliberate drop', () => {
      expect(isIgnoredClaudeEvent({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'loop' }] })).toBe(true)
    })

    it('does not claim non-system events or junk input', () => {
      expect(isIgnoredClaudeEvent({ type: 'unknown_event', subtype: 'thinking_tokens' })).toBe(false)
      expect(isIgnoredClaudeEvent(null)).toBe(false)
      expect(isIgnoredClaudeEvent('thinking_tokens')).toBe(false)
    })
  })

  describe('assistant events', () => {
    it('normalizes text content', () => {
      const result = normalizeClaude(TEXT_ASSISTANT)
      expect(result).toMatchObject({
        type: 'content',
        data: {
          blocks: [{ type: 'text', text: 'Hello, how can I help?' }],
          parentToolUseId: null,
        },
      })
    })

    it('normalizes thinking + text content', () => {
      const result = normalizeClaude(THINKING_ASSISTANT)
      expect(result).toMatchObject({
        type: 'content',
        data: {
          blocks: [
            { type: 'thinking', thinking: 'Let me think about this...' },
            { type: 'text', text: 'Here is my answer.' },
          ],
          parentToolUseId: null,
        },
      })
    })

    it('normalizes tool_use content', () => {
      const result = normalizeClaude(TOOL_USE_ASSISTANT)
      expect(result).toMatchObject({
        type: 'content',
        data: {
          blocks: [
            { type: 'text', text: "I'll read that file for you." },
            {
              type: 'tool_use',
              id: 'toolu_read_001',
              name: 'Read',
              input: { file_path: '/tmp/test.txt' },
            },
          ],
          parentToolUseId: null,
        },
      })
    })

    it('extracts apiUsage from assistant message usage', () => {
      const result = normalizeClaude(TEXT_ASSISTANT)
      const data = result!.data as Record<string, unknown>
      expect(data.apiUsage).toEqual({
        input_tokens: 200,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      })
    })

    it('extracts apiUsage with cache tokens', () => {
      const event = {
        type: 'assistant',
        message: {
          id: 'msg_002',
          content: [{ type: 'text', text: 'response' }],
          usage: {
            input_tokens: 1,
            output_tokens: 80,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 36000,
          },
        },
      }
      const result = normalizeClaude(event)
      const data = result!.data as Record<string, unknown>
      expect(data.apiUsage).toEqual({
        input_tokens: 1,
        output_tokens: 80,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 36000,
      })
    })

    it('extracts the serving model from the assistant message', () => {
      const result = normalizeClaude(TEXT_ASSISTANT)
      const data = result!.data as Record<string, unknown>
      expect(data.model).toBe('claude-opus-4-20250514')
    })

    it('omits model when the assistant message has none', () => {
      const event = {
        type: 'assistant',
        message: {
          id: 'msg_004',
          content: [{ type: 'text', text: 'no model' }],
        },
      }
      const result = normalizeClaude(event)
      const data = result!.data as Record<string, unknown>
      expect(data.model).toBeUndefined()
    })

    it('omits apiUsage when message has no usage field', () => {
      const event = {
        type: 'assistant',
        message: {
          id: 'msg_003',
          content: [{ type: 'text', text: 'no usage' }],
        },
      }
      const result = normalizeClaude(event)
      const data = result!.data as Record<string, unknown>
      expect(data.apiUsage).toBeUndefined()
    })

    it('returns null for assistant with missing message', () => {
      expect(normalizeClaude({ type: 'assistant' })).toBeNull()
    })

    it('returns null for assistant with missing content', () => {
      expect(normalizeClaude({ type: 'assistant', message: {} })).toBeNull()
    })
  })

  describe('user events (tool results)', () => {
    it('normalizes tool_result content', () => {
      const result = normalizeClaude(TOOL_RESULT_USER)
      expect(result).toMatchObject({
        type: 'result',
        data: {
          blocks: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_read_001',
              content: 'File contents here',
            },
          ],
          parentToolUseId: null,
        },
      })
    })

    it('returns null for user with missing message', () => {
      expect(normalizeClaude({ type: 'user' })).toBeNull()
    })
  })

  describe('result events', () => {
    it('normalizes success result to turn:end with full usage and cost', () => {
      const result = normalizeClaude(RESULT_SUCCESS)
      expect(result).toEqual({
        type: 'turn:end',
        data: {
          usage: { input_tokens: 250, output_tokens: 180, cache_creation_input_tokens: 0, cache_read_input_tokens: 20626 },
          duration: 4236,
          costUsd: 0.29,
        },
      })
    })

    it('normalizes error result to turn:end', () => {
      const result = normalizeClaude(RESULT_ERROR)
      expect(result).toEqual({
        type: 'turn:end',
        data: {
          usage: undefined,
          duration: 100,
          costUsd: undefined,
          error: { message: 'Something went wrong' },
        },
      })
    })

    it('keeps the CLI\'s failure text and reason on an api_error result', () => {
      // Shape recorded from `claude -p --output-format stream-json` with an invalid key.
      const result = normalizeClaude({
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'api_error',
        api_error_status: 401,
        duration_ms: 0,
        result: 'Failed to authenticate. API Error: 401 API key is invalid.',
        session_id: 'abc-123',
      })
      expect((result!.data as { error?: unknown }).error).toEqual({
        message: 'Failed to authenticate. API Error: 401 API key is invalid.',
        reason: 'api_error',
      })
    })
  })

  describe('edge cases', () => {
    it('returns null for null input', () => {
      expect(normalizeClaude(null)).toBeNull()
    })

    it('returns null for undefined input', () => {
      expect(normalizeClaude(undefined)).toBeNull()
    })

    it('returns null for non-object input', () => {
      expect(normalizeClaude('string')).toBeNull()
      expect(normalizeClaude(42)).toBeNull()
    })

    it('returns null for unknown event type', () => {
      expect(normalizeClaude({ type: 'unknown_event' })).toBeNull()
    })

    it('drops unknown content block types in assistant events', () => {
      const event = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'unknown_block', data: 'ignored' },
          ],
        },
      }
      const result = normalizeClaude(event)
      expect(result!.data).toMatchObject({
        blocks: [{ type: 'text', text: 'hello' }],
        parentToolUseId: null,
      })
    })

    it('handles empty content arrays', () => {
      const event = {
        type: 'assistant',
        message: { content: [] },
      }
      const result = normalizeClaude(event)
      expect(result).toMatchObject({ type: 'content', data: { blocks: [], parentToolUseId: null } })
    })
  })
})
