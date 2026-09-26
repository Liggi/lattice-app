import React from 'react';
import { LinearMark } from './linear-glyphs.js';

/**
 * Per-product brand tokens for MCP tool cards.
 *
 * Marks are reproduced unaltered and used only to identify which product a result
 * came from — the use every vendor's brand guidelines permit. Accents are taken from
 * each vendor's published brand colour. Where a product returns its own colours in
 * the payload (Linear's hex, Notion's palette names) those win over anything here,
 * so a card matches the workspace rather than a guess.
 */

export interface Brand {
  key: string;
  label: string;
  /** Accent used for the card border/tint and the mark. */
  accent: string;
  /**
   * Accent for dark backgrounds. Notion's brand colour is near-black, which disappears
   * on a dark card — their own product inverts the mark, and so do we.
   */
  accentDark?: string;
  Mark: (props: { size?: number; className?: string }) => React.JSX.Element;
}

// ── Marks ──

function SlackMark({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 122.8 122.8" aria-label="Slack" role="img">
      <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9z" fill="#E01E5A" />
      <path d="M32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A" />
      <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2z" fill="#36C5F0" />
      <path d="M45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0" />
      <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2z" fill="#2EB67D" />
      <path d="M90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D" />
      <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9z" fill="#ECB22E" />
      <path d="M77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E" />
    </svg>
  );
}

function NotionMark({ size = 14, className }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-label="Notion" role="img">
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466l1.823 1.447zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952l1.448.327s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933l3.222-.187zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.727l-15.458.933c-.98.047-1.448-.093-1.962-.746l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
    </svg>
  );
}

function GitHubMark({ size = 14, className }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-label="GitHub" role="img">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

// ── Registry ──

export const BRANDS: Record<string, Brand> = {
  slack: { key: 'slack', label: 'Slack', accent: '#4A154B', Mark: SlackMark },
  notion: { key: 'notion', label: 'Notion', accent: '#191919', accentDark: '#E3E3E1', Mark: NotionMark },
  linear: { key: 'linear', label: 'Linear', accent: '#5E6AD2', Mark: LinearMark },
  github: { key: 'github', label: 'GitHub', accent: '#24292F', accentDark: '#E6EDF3', Mark: GitHubMark },
};

/** Map an MCP tool name onto a brand, across both Claude and Codex naming schemes. */
export function brandFor(toolName: string): Brand | null {
  const n = toolName.toLowerCase();
  if (n.includes('slack')) return BRANDS.slack;
  if (n.includes('notion')) return BRANDS.notion;
  if (n.includes('linear')) return BRANDS.linear;
  if (n.includes('github')) return BRANDS.github;
  return null;
}

/** The tool's action, with the server prefix stripped, for the card header. */
export function actionName(toolName: string): string {
  return toolName
    .replace(/^mcp__(?:claude_ai_)?[^_]+(?:_[^_]+)*?__/, '')
    .replace(/^MCP:[^.]+\./, '')
    .replace(/^(?:linear_|notion-|API-|slack_|conversations_)/, '')
    .replace(/[_-]/g, ' ');
}

/**
 * Notion returns colour as a palette *name* rather than hex, so it needs translating.
 * Values are Notion's own text colours.
 */
export const NOTION_PALETTE: Record<string, string> = {
  default: '#787774',
  gray: '#787774',
  grey: '#787774',
  brown: '#9F6B53',
  orange: '#D9730D',
  yellow: '#CB912F',
  green: '#448361',
  blue: '#337EA9',
  purple: '#9065B0',
  pink: '#C14C8A',
  red: '#D44C47',
};

export function notionColor(name?: string): string | undefined {
  if (!name) return undefined;
  const base = name.replace(/_background$/, '');
  return NOTION_PALETTE[base];
}

/** A state or role in the product's own colour, as text: no pill, no dot. */
export function BrandLabel({ label, color }: { label: string; color?: string }): React.JSX.Element {
  return (
    <span className="text-[11px] whitespace-nowrap" style={{ color: color || '#8A8F98' }}>
      {label}
    </span>
  );
}
