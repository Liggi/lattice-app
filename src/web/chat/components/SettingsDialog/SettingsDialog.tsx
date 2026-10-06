/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
import React, { useState, useEffect } from 'react';
import { Settings, X, Check, Loader2, Download, Copy, CheckCircle2, ChevronDown } from 'lucide-react';
import { api } from '../../services/api';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import { ProviderAuthTab } from './ProviderAuthTab';
import { BackgroundCallsTab } from './BackgroundCallsTab';
import { CLAUDE_MODELS } from '@/constants/claude-models';
import { FeedbackSettingsSection } from '../Feedback/FeedbackSettingsSection';
import { UpdateSettingsSection } from '../Update/UpdateNotice';

type SettingsTab = 'auth' | 'background' | 'connection' | 'general';

const TABS: Array<[SettingsTab, string]> = [
  ['auth', 'Providers'],
  ['background', 'Background'],
  ['connection', 'Access'],
  ['general', 'General'],
];

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Tab shown on open; Providers (sign-in) unless the caller names another. */
  initialTab?: SettingsTab;
}


export function SettingsDialog({ isOpen, onClose, initialTab = 'auth' }: SettingsDialogProps): JSX.Element | null {
  const { serverConfig, setServerConfig } = usePreferencesContext();
  const [defaultClaudeModel, setDefaultClaudeModel] = useState('');
  const [launchFolder, setLaunchFolder] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launchFolderError, setLaunchFolderError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  // Detect current access context
  const currentUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const isLocal = currentUrl.includes('localhost') || currentUrl.includes('127.0.0.1');
  const port = serverConfig?.port || 3001;

  // Generate URLs - use server-detected Tailscale IP when available
  const localUrl = `http://localhost:${port}`;
  const [tailscale, setTailscale] = useState({
    tailscaleIp: serverConfig?.tailscaleIp ?? null,
    tailscaleCli: serverConfig?.tailscaleCli ?? null,
    tailscaleServe: serverConfig?.tailscaleServe ?? null,
  });
  const { tailscaleIp } = tailscale;
  const tailscaleUrl = tailscaleIp ? `http://${tailscaleIp}:${port}` : null;
  // A loopback bind cannot be reached at the tailnet IP; `tailscale serve` proxies to it.
  const host = serverConfig?.host;
  const listensLocallyOnly = !host || host === 'localhost' || host === '::1' || host.startsWith('127.');
  // The server picks a port that leaves anything already served (say, another Lattice) alone.
  const tailscaleServeCommand = tailscale.tailscaleServe?.command ?? null;
  const tailscaleServeUrl = tailscale.tailscaleServe?.url ?? null;

  const copyUrl = (url: string) => {
    void navigator.clipboard.writeText(url);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(null), 2000);
  };

  // Load current config when dialog opens
  useEffect(() => {
    if (isOpen) setActiveTab(initialTab);
  }, [isOpen, initialTab]);

  useEffect(() => {
    if (!isOpen || activeTab !== 'connection') return;
    let cancelled = false;
    api.detectTailscale().then((detected) => {
      if (!cancelled) setTailscale(detected);
    }).catch(err => {
      console.error('Failed to check for Tailscale:', err);
    });
    return () => { cancelled = true; };
  }, [isOpen, activeTab]);

  useEffect(() => {
    if (isOpen) {
      api.getConfig().then(config => {
        setDefaultClaudeModel(config.server?.defaultModel || '');
        setLaunchFolder(config.server?.defaultWorkingDirectory || '');
      }).catch(err => {
        console.error('Failed to load config:', err);
      });
    }
  }, [isOpen]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setLaunchFolderError(null);
    setSaved(false);

    try {
      const folder = launchFolder.trim();
      if (folder) {
        try {
          await api.listDirectory({ path: folder });
        } catch (err) {
          setLaunchFolderError(`Can't use this launch folder. ${err instanceof Error ? err.message : `Not found: ${folder}`}`);
          return;
        }
      }
      const updatedConfig = await api.updateConfig({
        server: {
          // '' clears a saved value: the merge keeps a key that is left out.
          defaultModel: defaultClaudeModel,
          defaultWorkingDirectory: folder,
        },
      });
      setServerConfig(updatedConfig.server || null);
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        onClose();
      }, 1500);
    } catch (err) {
      setError('Failed to save settings');
      console.error('Failed to save config:', err);
    } finally {
      setSaving(false);
    }
  };

  const hasForm = activeTab === 'general';

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center sm:items-center"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1rem)',
        paddingRight: 'calc(env(safe-area-inset-right, 0px) + 1rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)',
        paddingLeft: 'calc(env(safe-area-inset-left, 0px) + 1rem)',
      }}
    >
      {/* Backdrop */}
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-label="Close settings dialog"
      />

      {/* Dialog */}
      <div className="relative z-10 w-full max-w-2xl bg-surface border border-line rounded-lg overflow-hidden max-h-[calc(100dvh-2rem)] sm:max-h-[90vh] flex flex-col">
        {/* Header with tabs */}
        <div className="relative px-4 py-3 border-b border-line space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Settings size={16} className="text-fg-3" />
              <span className="text-sm font-medium text-fg">Settings</span>
            </div>
            <button
              onClick={onClose}
              className="shrink-0 p-1 rounded-sm text-fg-3 hover:text-fg hover:bg-surface-2 transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>
          {/* Tabs */}
          <div className="flex flex-wrap items-center gap-1">
            {TABS.map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-2 sm:px-3 py-1 text-[13px] whitespace-nowrap rounded-md transition-colors cursor-pointer ${
                  activeTab === tab
                    ? 'bg-surface-2 text-fg'
                    : 'text-fg-2 hover:text-fg'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="relative p-4 space-y-5 overflow-y-auto flex-1">
          {activeTab === 'connection' && (
            <>
              <p className="text-xs text-fg-3">
                Where to open this Lattice from.
              </p>

              {/* Local Access */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-fg-2">Local access</span>
                  {isLocal && <span className="text-xs text-accent">(current)</span>}
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-bg border border-line-2 rounded-md text-sm font-mono text-fg">
                    {localUrl}
                  </code>
                  <button
                    onClick={() => copyUrl(localUrl)}
                    className="ui-icon-btn p-2 cursor-pointer"
                  >
                    {copiedUrl === localUrl ? <CheckCircle2 size={16} className="text-emerald-400" /> : <Copy size={16} />}
                  </button>
                </div>
                <p className="text-xs text-fg-3">
                  Use when on the same machine as the Lattice server
                </p>
              </div>

              {/* Remote/Tailscale Access */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-fg-2">Remote access (Tailscale)</span>
                  {!isLocal && <span className="text-xs text-accent">(current)</span>}
                </div>
                {tailscaleIp && listensLocallyOnly && !tailscaleServeCommand && tailscaleServeUrl ? (
                  <>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 px-3 py-2 bg-bg border border-line-2 rounded-md text-sm font-mono text-fg">
                        {tailscaleServeUrl}
                      </code>
                      <button
                        onClick={() => copyUrl(tailscaleServeUrl)}
                        className="ui-icon-btn p-2 cursor-pointer"
                      >
                        {copiedUrl === tailscaleServeUrl ? <CheckCircle2 size={16} className="text-emerald-400" /> : <Copy size={16} />}
                      </button>
                    </div>
                    <p className="text-xs text-fg-3">
                      Tailscale already serves this Lattice at that address. Anyone on your tailnet who can open it can run agents as you.
                    </p>
                  </>
                ) : tailscaleIp && listensLocallyOnly && tailscaleServeCommand ? (
                  <>
                    <p className="text-xs text-fg-2">
                      This server only listens on this machine. To reach it from your phone or another
                      device on your tailnet, run this on the server machine:
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 px-3 py-2 bg-bg border border-line-2 rounded-md text-sm font-mono text-fg">
                        {tailscaleServeCommand}
                      </code>
                      <button
                        onClick={() => copyUrl(tailscaleServeCommand)}
                        className="ui-icon-btn p-2 cursor-pointer"
                      >
                        {copiedUrl === tailscaleServeCommand ? <CheckCircle2 size={16} className="text-emerald-400" /> : <Copy size={16} />}
                      </button>
                    </div>
                    <p className="text-xs text-fg-3">
                      Then open {tailscaleServeUrl ?? 'the https://….ts.net address it prints'}. Anyone on your tailnet who can open it can run agents as you.
                    </p>
                  </>
                ) : tailscaleUrl ? (
                  <>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 px-3 py-2 bg-bg border border-line-2 rounded-md text-sm font-mono text-fg">
                        {tailscaleUrl}
                      </code>
                      <button
                        onClick={() => copyUrl(tailscaleUrl)}
                        className="ui-icon-btn p-2 cursor-pointer"
                      >
                        {copiedUrl === tailscaleUrl ? <CheckCircle2 size={16} className="text-emerald-400" /> : <Copy size={16} />}
                      </button>
                    </div>
                    <p className="text-xs text-fg-3">
                      Use when accessing from another device on your Tailscale network
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-fg-3">
                    Tailscale not found on this machine. Install it and sign in, then reopen this tab to check again.
                  </p>
                )}
              </div>

            </>
          )}

          {activeTab === 'auth' && (
            <ProviderAuthTab />
          )}

          {activeTab === 'background' && (
            <BackgroundCallsTab onOpenProviders={() => setActiveTab('auth')} />
          )}

          {activeTab === 'general' && (
            <>
              <div>
                <p className="text-xs text-fg-3">
                  Defaults for every new session.
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="settings-default-claude-model" className="text-xs font-medium text-fg-2 flex items-center gap-2">
                  Default Claude model
                </label>
                <div className="relative">
                  <select
                    id="settings-default-claude-model"
                    value={defaultClaudeModel}
                    onChange={(e) => setDefaultClaudeModel(e.target.value)}
                    className="w-full appearance-none pl-3 pr-9 py-2 bg-bg border border-line-2 rounded-md text-sm text-fg cursor-pointer focus:outline-none focus:border-accent"
                  >
                    <option value="">Claude Code default</option>
                    {CLAUDE_MODELS.filter((model) => !model.supersededBy).map((model) => (
                      <option key={model.id} value={model.id}>{model.label}</option>
                    ))}
                  </select>
                  <ChevronDown size={14} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-3" />
                </div>
                <p className="text-xs text-fg-3">
                  Used for new Claude sessions when no model is picked in the composer. Claude Code default runs whatever the Claude CLI on this machine defaults to for your account.
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="settings-launch-folder" className="text-xs font-medium text-fg-2 flex items-center gap-2">
                  Launch folder
                </label>
                <input
                  id="settings-launch-folder"
                  data-testid="settings-launch-folder"
                  value={launchFolder}
                  onChange={(e) => { setLaunchFolder(e.target.value); setLaunchFolderError(null); }}
                  placeholder="~"
                  spellCheck={false}
                  autoCapitalize="off"
                  className="w-full px-3 py-2 bg-bg border border-line-2 rounded-md text-sm font-mono text-fg focus:outline-none focus:border-accent"
                />
                {launchFolderError && (
                  <p className="text-xs text-rose-300">{launchFolderError}</p>
                )}
                <p className="text-xs text-fg-3">
                  Every new session and project starts here, on this machine. Point it at the folder that holds your repos; the agents find the ones the work involves.
                </p>
              </div>

              <UpdateSettingsSection />

              <FeedbackSettingsSection />

              <div className="border-t border-line pt-4">
                <p className="text-xs font-medium text-fg-2 mb-3">Diagnostics</p>
                <button
                  onClick={() => api.exportLogs(10)}
                  className="ui-action-btn flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer"
                >
                  <Download size={14} />
                  <span>Export diagnostics (last 10 min)</span>
                </button>
                <p className="text-xs text-fg-3 mt-1.5">
                  Downloads structured server, daemon, events, permissions, and browser incidents
                </p>
              </div>
            </>
          )}

          {/* Error message */}
          {error && (
            <p className="text-xs text-rose-300">{error}</p>
          )}
        </div>

        {/* Actions. Providers and Access save as you go, so they close with
            Done; only General has a form, with Cancel/Save. */}
        <div className="relative px-4 py-3 border-t border-line flex items-center justify-end gap-3">
          {!hasForm ? (
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-[13px] font-medium text-accent hover:bg-accent-soft transition-colors cursor-pointer"
            >
              Done
            </button>
          ) : (
          <>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-[13px] text-fg-2 hover:text-fg transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] font-medium text-accent hover:bg-accent-soft transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            {saving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : saved ? (
              <>
                <Check size={14} />
                <span>Saved</span>
              </>
            ) : (
              <>
                <Check size={14} />
                <span>Save</span>
              </>
            )}
          </button>
          </>
          )}
        </div>
      </div>
    </div>
  );
}
