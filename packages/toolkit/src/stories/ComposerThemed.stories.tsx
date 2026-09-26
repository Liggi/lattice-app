import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Composer } from '../components/Composer';

/**
 * Themed Composer stories — wraps the Composer in a container that
 * overrides the CSS custom properties, simulating how consumers
 * (Lattice, Analyst) retheme the component.
 *
 * Use the Controls panel to adjust colors live.
 */

interface ThemedComposerArgs {
  colorActive: string;
  colorReady: string;
  colorCaution: string;
  colorDanger: string;
  colorMuted: string;
  colorSurface: string;
  colorSurfaceElevated: string;
  colorBorder: string;
  colorText: string;
  colorTextSecondary: string;
  colorTextFaint: string;
  panelBg: string;
  status: 'off' | 'ready' | 'active' | 'starting' | 'stopping';
}

function ThemedComposer({
  colorActive,
  colorReady,
  colorCaution,
  colorDanger,
  colorMuted,
  colorSurface,
  colorSurfaceElevated,
  colorBorder,
  colorText,
  colorTextSecondary,
  colorTextFaint,
  panelBg,
  status,
}: ThemedComposerArgs) {
  const vars: Record<string, string> = {
    '--color-composer-active': colorActive,
    '--color-composer-ready': colorReady,
    '--color-composer-caution': colorCaution,
    '--color-composer-danger': colorDanger,
    '--color-composer-muted': colorMuted,
    '--color-composer-surface': colorSurface,
    '--color-composer-surface-elevated': colorSurfaceElevated,
    '--color-composer-border': colorBorder,
    '--color-composer-text': colorText,
    '--color-composer-text-secondary': colorTextSecondary,
    '--color-composer-text-faint': colorTextFaint,
  };

  const swatches = [
    { label: 'Active', color: colorActive },
    { label: 'Ready', color: colorReady },
    { label: 'Caution', color: colorCaution },
    { label: 'Danger', color: colorDanger },
    { label: 'Muted', color: colorMuted },
    { label: 'Surface', color: colorSurface },
    { label: 'Border', color: colorBorder },
  ];

  const allStatuses: Array<{ label: string; cfg: ThemedComposerArgs['status'] }> = [
    { label: 'Off', cfg: 'off' },
    { label: 'Ready', cfg: 'ready' },
    { label: 'Active', cfg: 'active' },
    { label: 'Starting', cfg: 'starting' },
    { label: 'Stopping', cfg: 'stopping' },
  ];

  const showAll = status === 'off'; // "off" doubles as "show all states"

  return (
    <div style={{ ...vars }}>
      {/* Color swatches */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        {swatches.map(s => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 28, height: 28, borderRadius: 6, background: s.color, border: '1px solid rgba(0,0,0,0.1)' }} />
            <span style={{ fontSize: 11, color: '#63615D' }}>{s.label}<br/><code style={{ fontSize: 9, color: '#A2A09A' }}>{s.color}</code></span>
          </div>
        ))}
      </div>

      {/* Composers */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {(showAll ? allStatuses : [{ label: status, cfg: status }]).map(({ label, cfg }) => (
          <div key={label}>
            {showAll && <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.1em', color: '#A2A09A', marginBottom: 6 }}>{label}</div>}
            <div style={{ maxWidth: 800, padding: 20, borderRadius: 18, background: panelBg }}>
              <Composer
                core={{
                  onSubmit: (message: string) => console.log('Submit:', message),
                  placeholder: cfg === 'off' ? 'Ask a new analysis question...' : 'Send follow-up...',
                }}
                features={{
                  showStatusBar: true,
                  enableAttachments: true,
                }}
                runtimeConfig={{
                  isSessionActive: cfg === 'active',
                  isSessionConnected: cfg === 'ready' || cfg === 'active' || cfg === 'stopping',
                  isStopRequested: cfg === 'stopping',
                  isInitializing: cfg === 'starting',
                  sessionStartTime: cfg === 'active' ? Date.now() - 42_000 : undefined,
                }}
                permissionConfig={{
                  onStop: () => console.log('Stop'),
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const meta: Meta<typeof ThemedComposer> = {
  title: 'Composer/Themed',
  component: ThemedComposer,
  parameters: {
    layout: 'padded',
  },
  argTypes: {
    status: {
      control: 'select',
      options: ['off', 'ready', 'active', 'starting', 'stopping'],
    },
    colorActive:          { control: 'color', name: 'Active' },
    colorReady:           { control: 'color', name: 'Ready' },
    colorCaution:         { control: 'color', name: 'Caution' },
    colorDanger:          { control: 'color', name: 'Danger' },
    colorMuted:           { control: 'color', name: 'Muted' },
    colorSurface:         { control: 'color', name: 'Surface' },
    colorSurfaceElevated: { control: 'color', name: 'Surface elevated' },
    colorBorder:          { control: 'color', name: 'Border' },
    colorText:            { control: 'color', name: 'Text' },
    colorTextSecondary:   { control: 'color', name: 'Text secondary' },
    colorTextFaint:       { control: 'color', name: 'Text faint' },
    panelBg:              { control: 'color', name: 'Panel background' },
  },
};

export default meta;
type Story = StoryObj<typeof ThemedComposer>;

/** Parchment — current Analyst palette, warm and muted. */
export const Parchment: Story = {
  args: {
    status: 'ready',
    colorActive: '#855074',
    colorReady: '#568a61',
    colorCaution: '#c2850a',
    colorDanger: '#a24335',
    colorMuted: '#A2A09A',
    colorSurface: '#F6F3ED',
    colorSurfaceElevated: '#EBE7DE',
    colorBorder: '#DDDAD1',
    colorText: '#1A1918',
    colorTextSecondary: '#63615D',
    colorTextFaint: '#A2A09A',
    panelBg: '#F6F3ED',
  },
};


/** Clean — white surfaces, bright accents, modern feel. */
export const Clean: Story = {
  args: {
    status: 'ready',
    colorActive: '#6366f1',
    colorReady: '#22c55e',
    colorCaution: '#f59e0b',
    colorDanger: '#ef4444',
    colorMuted: '#9ca3af',
    colorSurface: '#ffffff',
    colorSurfaceElevated: '#f9fafb',
    colorBorder: '#e5e7eb',
    colorText: '#111827',
    colorTextSecondary: '#6b7280',
    colorTextFaint: '#9ca3af',
    panelBg: '#f3f4f6',
  },
};

/** Mocha — dark warm surfaces, cream text, coffee tones. */
export const Mocha: Story = {
  args: {
    status: 'ready',
    colorActive: '#e0a458',
    colorReady: '#8fbc6a',
    colorCaution: '#e0a458',
    colorDanger: '#e06c6c',
    colorMuted: '#7a7068',
    colorSurface: '#2c2520',
    colorSurfaceElevated: '#3a322c',
    colorBorder: '#4a403a',
    colorText: '#f0e6d8',
    colorTextSecondary: '#b8a898',
    colorTextFaint: '#7a7068',
    panelBg: '#2c2520',
  },
};

/** Ink — cool slate surfaces, deep navy accents, editorial. */
export const Ink: Story = {
  args: {
    status: 'ready',
    colorActive: '#3b82f6',
    colorReady: '#10b981',
    colorCaution: '#f59e0b',
    colorDanger: '#ef4444',
    colorMuted: '#64748b',
    colorSurface: '#1e293b',
    colorSurfaceElevated: '#334155',
    colorBorder: '#475569',
    colorText: '#f1f5f9',
    colorTextSecondary: '#94a3b8',
    colorTextFaint: '#64748b',
    panelBg: '#1e293b',
  },
};

/** Rose — soft pink surfaces, warm romantic tones. */
export const Rose: Story = {
  args: {
    status: 'ready',
    colorActive: '#be185d',
    colorReady: '#059669',
    colorCaution: '#d97706',
    colorDanger: '#dc2626',
    colorMuted: '#a8a29e',
    colorSurface: '#fff1f2',
    colorSurfaceElevated: '#ffe4e6',
    colorBorder: '#fecdd3',
    colorText: '#1c1917',
    colorTextSecondary: '#78716c',
    colorTextFaint: '#a8a29e',
    panelBg: '#fff1f2',
  },
};

/** Cyberpunk (Lattice) — dark with cyan/neon accents. */
export const Cyberpunk: Story = {
  args: {
    status: 'ready',
    colorActive: '#22d3ee',
    colorReady: '#34d399',
    colorCaution: '#fbbf24',
    colorDanger: '#f43f5e',
    colorMuted: '#71717a',
    colorSurface: '#0c0a09',
    colorSurfaceElevated: '#1c1917',
    colorBorder: '#44403c',
    colorText: '#fafaf9',
    colorTextSecondary: '#a8a29e',
    colorTextFaint: '#78716c',
    panelBg: '#0c0a09',
  },
};
