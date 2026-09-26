import React from 'react';
import { brandFor } from './brand.js';
import { SlackCard } from './SlackCard.js';
import { NotionCard } from './NotionCard.js';
import { LinearCard } from './LinearCard.js';
import { GitHubCard } from './GitHubCard.js';
import { McpCard } from './McpCard.js';

/**
 * Picks the brand card for an MCP tool, falling back to the generic one.
 *
 * Matching is case-insensitive and covers both naming schemes — Claude emits
 * `mcp__server__tool` (and `mcp__claude_ai_Server__tool`), the Codex adapter emits
 * `MCP:server.tool`. The shipping switch in ToolContent.tsx tests lowercase substrings,
 * so `mcp__claude_ai_Linear__get_issue` and `MCP:linear.linear_get_issue` both miss it.
 */

export interface McpToolProps {
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  isError?: boolean;
}

export function renderMcpTool(props: McpToolProps): React.JSX.Element {
  const brand = brandFor(props.toolName);
  switch (brand?.key) {
    case 'slack':
      return <SlackCard {...props} />;
    case 'notion':
      return <NotionCard {...props} />;
    case 'linear':
      return <LinearCard {...props} />;
    case 'github':
      return <GitHubCard {...props} />;
    default:
      return <McpCard {...props} />;
  }
}

/** True when the name is an MCP tool under either provider's naming scheme. */
export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith('mcp__') || /^MCP:/i.test(toolName);
}

/**
 * Chrome DevTools keeps its own renderer rather than a brand card — the payloads
 * are prose and page state, not records. Matches both hyphen and underscore
 * spellings, plus the `chrome_isolated` second instance.
 */
export function isChromeDevToolsTool(toolName: string): boolean {
  return /chrome[-_](?:devtools|isolated)/i.test(toolName);
}

/** Human label for a pending MCP call: the tool half of the name, spaced out. */
export function mcpToolLabel(toolName: string): string {
  const claude = toolName.match(/^mcp__.+?__(.+)$/);
  const codex = toolName.match(/^MCP:[^.]+\.(.+)$/i);
  const tool = claude?.[1] ?? codex?.[1];
  return tool ? tool.replace(/[_-]+/g, ' ') : toolName;
}

export { SlackCard, NotionCard, LinearCard, GitHubCard, McpCard };
export { brandFor, actionName, BRANDS } from './brand.js';
export { McpResultBody } from './McpResultBody.js';
export { unwrapResult, summariseResult } from './unwrapResult.js';
