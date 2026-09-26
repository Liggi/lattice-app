/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
import React, { useState, useEffect, useMemo } from 'react';
import { Settings, X, Check, Loader2, Download, User, Globe, Copy, CheckCircle2, Bell, BellOff } from 'lucide-react';
import { api } from '../../services/api';
import { usePreferencesContext } from '../../contexts/PreferencesContext';
import { usePushNotifications } from '../../hooks/usePushNotifications';
import { ProviderAuthTab } from './ProviderAuthTab';
import { SecretKeyField } from './SecretKeyField';
import { CLAUDE_MODELS } from '@/constants/claude-models';

type SettingsTab = 'credentials' | 'auth' | 'persona' | 'runtime' | 'connection' | 'notifications';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Tab shown on open; Providers (sign-in) unless the caller names another. */
  initialTab?: SettingsTab;
}


export function SettingsDialog({ isOpen, onClose, initialTab = 'auth' }: SettingsDialogProps): JSX.Element | null {
  const { serverConfig, setServerConfig } = usePreferencesContext();
  // Keys are never read back from the server: only whether one is saved.
  const [anthropicKeyConfigured, setAnthropicKeyConfigured] = useState(false);
  const [geminiKeyConfigured, setGeminiKeyConfigured] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [defaultClaudeModel, setDefaultClaudeModel] = useState('');
  const [launchFolder, setLaunchFolder] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [enablingNotifications, setEnablingNotifications] = useState(false);
  const push = usePushNotifications();

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

  // Compute persona stats
  const personaStats = useMemo(() => {
    const lines = systemPrompt.split('\n').length;
    const chars = systemPrompt.length;
    return { lines, chars };
  }, [systemPrompt]);

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
        setAnthropicKeyConfigured(config.anthropic?.apiKeyConfigured === true);
        setGeminiKeyConfigured(config.gemini?.apiKeyConfigured === true);
        setSystemPrompt(config.server?.systemPrompt || '');
        setDefaultClaudeModel(config.server?.defaultModel || '');
        setLaunchFolder(config.server?.defaultWorkingDirectory || '');
      }).catch(err => {
        console.error('Failed to load config:', err);
      });
    }
  }, [isOpen]);

  // A key saves on its own, the moment it is entered or removed.
  const saveKey = (section: 'anthropic' | 'gemini') => async (value: string | null): Promise<void> => {
    const updated = await api.updateConfig({ [section]: { apiKey: value } });
    setAnthropicKeyConfigured(updated.anthropic?.apiKeyConfigured === true);
    setGeminiKeyConfigured(updated.gemini?.apiKeyConfigured === true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const folder = launchFolder.trim();
      if (folder) {
        try {
          await api.listDirectory({ path: folder });
        } catch {
          setError(`Launch folder not found: ${folder}`);
          return;
        }
      }
      const updatedConfig = await api.updateConfig({
        server: {
          systemPrompt: systemPrompt || undefined,
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

  const hasForm = activeTab === 'persona' || activeTab === 'runtime';

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
            <button
              onClick={() => setActiveTab('auth')}
              className={`px-3 py-1 text-[13px] whitespace-nowrap rounded-md transition-colors cursor-pointer ${
                activeTab === 'auth'
                  ? 'bg-surface-2 text-fg'
                  : 'text-fg-2 hover:text-fg'
              }`}
            >
              Providers
            </button>
            <button
              onClick={() => setActiveTab('credentials')}
              className={`px-3 py-1 text-[13px] whitespace-nowrap rounded-md transition-colors cursor-pointer ${
                activeTab === 'credentials'
                  ? 'bg-surface-2 text-fg'
                  : 'text-fg-2 hover:text-fg'
              }`}
            >
              API Keys
            </button>
            <button
              onClick={() => setActiveTab('persona')}
              className={`px-3 py-1 text-[13px] whitespace-nowrap rounded-md transition-colors cursor-pointer ${
                activeTab === 'persona'
                  ? 'bg-surface-2 text-fg'
                  : 'text-fg-2 hover:text-fg'
              }`}
            >
              Persona
            </button>
            <button
              onClick={() => setActiveTab('connection')}
              className={`px-3 py-1 text-[13px] whitespace-nowrap rounded-md transition-colors cursor-pointer ${
                activeTab === 'connection'
                  ? 'bg-surface-2 text-fg'
                  : 'text-fg-2 hover:text-fg'
              }`}
            >
              Access
            </button>
            <button
              onClick={() => setActiveTab('runtime')}
              className={`px-3 py-1 text-[13px] whitespace-nowrap rounded-md transition-colors cursor-pointer ${
                activeTab === 'runtime'
                  ? 'bg-surface-2 text-fg'
                  : 'text-fg-2 hover:text-fg'
              }`}
            >
              Runtime
            </button>
            <button
              onClick={() => setActiveTab('notifications')}
              className={`px-3 py-1 text-[13px] whitespace-nowrap rounded-md transition-colors cursor-pointer ${
                activeTab === 'notifications'
                  ? 'bg-surface-2 text-fg'
                  : 'text-fg-2 hover:text-fg'
              }`}
            >
              Notify
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="relative p-4 space-y-5 overflow-y-auto flex-1">
          {activeTab === 'credentials' && (
            <>
              <div>
                <p className="text-xs font-medium text-fg-2 mb-2">API credentials</p>
                <p className="text-xs text-fg-3">
                  Local storage: <code className="px-1.5 py-0.5 bg-bg rounded-sm font-mono text-fg border border-line">local config file</code>
                </p>
              </div>

              <SecretKeyField
                id="settings-anthropic-key"
                label="Anthropic key"
                hint="Summaries, quick answers, reviews; conversations only if Providers says so"
                placeholder="sk-ant-..."
                configured={anthropicKeyConfigured}
                onSave={saveKey('anthropic')}
              />

              <SecretKeyField
                id="settings-gemini-key"
                label="Google key"
                hint="Optional"
                placeholder="AIza..."
                configured={geminiKeyConfigured}
                onSave={saveKey('gemini')}
              />

              {/* Divider */}
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

          {activeTab === 'persona' && (
            <>
              <div>
                <p className="text-xs font-medium text-fg-2 mb-2">Claude persona</p>
                <p className="text-xs text-fg-3">
                  Define how Claude should behave across all sessions. This becomes the system prompt.
                </p>
              </div>

              {/* Persona Editor */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="settings-persona" className="text-xs font-medium text-fg-2 flex items-center gap-2">
                    <User size={12} className="text-fg-3" />
                    Persona
                  </label>
                  <span className="text-xs text-fg-3 tabular-nums">
                    {personaStats.lines} lines · {personaStats.chars} chars
                  </span>
                </div>
                <textarea
                  id="settings-persona"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder={`## Collaboration Model

You are a peer collaborator, not an assistant...

**Epistemic standards:**
- Verify before claiming...

**Communication:**
- Be direct and information-dense...`}
                  rows={16}
                  className="w-full px-3 py-2 bg-bg border border-line-2 rounded-md text-sm font-mono text-fg placeholder:text-fg-3 focus:outline-none focus:border-accent resize-y min-h-[300px]"
                />
                <div className="flex items-start justify-between gap-4">
                  <p className="text-xs text-fg-3 flex-1">
                    Supports markdown. Defines personality, communication style, epistemic standards, and working preferences. Applied to all new sessions via <code className="font-mono text-fg-2">--system-prompt</code>.
                  </p>
                </div>
              </div>

              {/* Tips */}
              <div className="border border-line rounded-lg p-3 bg-bg">
                <p className="text-xs font-medium text-fg-2 mb-2">Tips</p>
                <ul className="text-xs text-fg-2 space-y-1">
                  <li>• Use <code className="font-mono text-fg">##</code> headers to organize sections</li>
                  <li>• Be explicit - Claude 4.x follows instructions literally</li>
                  <li>• Include both what TO do and HOW to do it</li>
                  <li>• Changes apply to new sessions only</li>
                </ul>
              </div>
            </>
          )}

          {activeTab === 'connection' && (
            <>
              <div>
                <p className="text-xs font-medium text-fg-2 mb-2">Access URLs</p>
                <p className="text-xs text-fg-3">
                  Access Lattice from different networks. Currently accessing via: <code className="px-1.5 py-0.5 bg-bg rounded-sm font-mono text-fg border border-line">{isLocal ? 'localhost' : 'remote'}</code>
                </p>
              </div>

              {/* Current Access */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Globe size={14} className="text-fg-3" />
                  <span className="text-xs font-medium text-fg-2">Current URL</span>
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-bg border border-line-2 rounded-md text-sm font-mono text-fg">
                    {currentUrl}
                  </code>
                  <button
                    onClick={() => copyUrl(currentUrl)}
                    className="ui-icon-btn p-2 cursor-pointer"
                  >
                    {copiedUrl === currentUrl ? <CheckCircle2 size={16} className="text-emerald-400" /> : <Copy size={16} />}
                  </button>
                </div>
              </div>

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

              {/* Tips */}
              <div className="border border-line rounded-lg p-3 bg-bg">
                <p className="text-xs font-medium text-fg-2 mb-2">Quick tips</p>
                <ul className="text-xs text-fg-2 space-y-1">
                  <li>• <code className="font-mono text-fg">localhost</code> only works on the server machine</li>
                  <li>• Session links use relative paths - just swap the hostname</li>
                </ul>
              </div>
            </>
          )}

          {activeTab === 'auth' && (
            <ProviderAuthTab />
          )}

          {activeTab === 'runtime' && (
            <>
              <div>
                <p className="text-xs font-medium text-fg-2 mb-2">Runtime defaults</p>
                <p className="text-xs text-fg-3">
                  Global defaults for every new session.
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="settings-default-claude-model" className="text-xs font-medium text-fg-2 flex items-center gap-2">
                  Default Claude model
                </label>
                <select
                  id="settings-default-claude-model"
                  value={defaultClaudeModel}
                  onChange={(e) => setDefaultClaudeModel(e.target.value)}
                  className="w-full px-3 py-2 bg-bg border border-line-2 rounded-md text-sm font-mono text-fg focus:outline-none focus:border-accent"
                >
                  <option value="">Claude Code default</option>
                  {CLAUDE_MODELS.filter((model) => !model.supersededBy).map((model) => (
                    <option key={model.id} value={model.id}>{model.label} ({model.id})</option>
                  ))}
                </select>
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
                  onChange={(e) => { setLaunchFolder(e.target.value); setError(null); }}
                  placeholder="~"
                  spellCheck={false}
                  autoCapitalize="off"
                  className="w-full px-3 py-2 bg-bg border border-line-2 rounded-md text-sm font-mono text-fg focus:outline-none focus:border-accent"
                />
                <p className="text-xs text-fg-3">
                  Every new session and project starts here, on this machine. Point it at the folder that holds your repos; the agents find the ones the work involves.
                </p>
              </div>

            </>
          )}

          {activeTab === 'notifications' && (
            <>
              <div>
                <p className="text-xs font-medium text-fg-2 mb-2">Push notifications</p>
                <p className="text-xs text-fg-3">
                  Get notified when sessions complete or need attention. Works on mobile and desktop.
                </p>
              </div>

              {!push.supported ? (
                <div className="border border-line rounded-lg p-3 bg-[rgb(var(--color-amber-rgb)/0.1)]">
                  <p className="text-xs text-amber-400 mb-2">
                    Push notifications are unavailable in this browsing context.
                  </p>
                  <ul className="text-xs text-fg-2 space-y-1">
                    {push.supportIssues.includes('ios-home-screen-required') && (
                      <li>• iOS requirement: open Lattice as an installed Home Screen app (`Share` → `Add to Home Screen`) and enable notifications from that app.</li>
                    )}
                    {push.supportIssues.includes('insecure-context') && (
                      <li>• Secure context required: notifications need HTTPS (or localhost). Current origin: <span className="font-mono text-fg">{currentUrl}</span></li>
                    )}
                    {push.supportIssues.includes('missing-browser-apis') && (
                      <li>• This browser/runtime does not expose all required push APIs (`ServiceWorker`, `PushManager`, `Notification`).</li>
                    )}
                    {push.supportIssues.length === 0 && (
                      <li>• Browser push APIs are unavailable right now.</li>
                    )}
                  </ul>
                </div>
              ) : !push.publicKey ? (
                <div className="border border-line rounded-lg p-3 bg-[rgb(var(--color-amber-rgb)/0.1)] space-y-3">
                  <p className="text-xs text-amber-400">
                    Push notifications are not configured on the server yet.
                  </p>
                  <button
                    onClick={async () => {
                      setEnablingNotifications(true);
                      setError(null);
                      try {
                        await api.updateConfig({
                          interface: {
                            notifications: { enabled: true },
                          },
                        });
                        await push.refresh();
                      } catch (err) {
                        setError('Failed to enable notifications');
                        console.error('Failed to enable notifications:', err);
                      } finally {
                        setEnablingNotifications(false);
                      }
                    }}
                    disabled={enablingNotifications}
                    className="flex items-center gap-2 px-4 py-2 rounded-md bg-surface-2 text-fg text-[13px] font-medium hover:bg-line-2 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {enablingNotifications ? <Loader2 size={14} className="animate-spin" /> : <Bell size={14} />}
                    <span>{enablingNotifications ? 'Enabling...' : 'Enable on server'}</span>
                  </button>
                  <p className="text-xs text-fg-3">
                    This creates VAPID keys automatically and unlocks browser subscription.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Status */}
                  <div className="flex items-center gap-3">
                    {push.subscribed ? (
                      <Bell size={16} className="text-accent" />
                    ) : (
                      <BellOff size={16} className="text-fg-3" />
                    )}
                    <span className="text-sm text-fg">
                      {push.subscribed ? 'Notifications enabled' : 'Notifications disabled'}
                    </span>
                    {push.permission === 'denied' && (
                      <span className="text-xs text-rose-300">
                        (blocked by browser — check site permissions)
                      </span>
                    )}
                  </div>

                  {/* Toggle */}
                  <div className="flex items-center gap-3">
                    {push.subscribed ? (
                      <button
                        onClick={() => void push.unsubscribe()}
                        disabled={push.loading}
                        className="ui-action-btn ui-action-btn--rose flex items-center gap-2 px-4 py-2 text-[13px] font-medium cursor-pointer disabled:opacity-50"
                      >
                        {push.loading ? <Loader2 size={14} className="animate-spin" /> : <BellOff size={14} />}
                        <span>Disable</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => void push.subscribe()}
                        disabled={push.loading || push.permission === 'denied'}
                        className="flex items-center gap-2 px-4 py-2 rounded-md bg-surface-2 text-fg text-[13px] font-medium hover:bg-line-2 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        {push.loading ? <Loader2 size={14} className="animate-spin" /> : <Bell size={14} />}
                        <span>Enable notifications</span>
                      </button>
                    )}

                    {/* Test button */}
                    {push.subscribed && (
                      <button
                        onClick={async () => {
                          setTestResult(null);
                          const result = await push.sendTest();
                          if (result) {
                            setTestResult(`Sent: ${result.sent}, Failed: ${result.failed}`);
                          } else {
                            setTestResult('Test failed');
                          }
                          setTimeout(() => setTestResult(null), 3000);
                        }}
                        className="ui-action-btn flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer"
                      >
                        <span>Test</span>
                      </button>
                    )}
                  </div>

                  {testResult && (
                    <p className="text-xs text-fg-2">{testResult}</p>
                  )}

                  {/* Info */}
                  <div className="border border-line rounded-lg p-3 bg-bg">
                    <p className="text-xs font-medium text-fg-2 mb-2">What you'll get notified about</p>
                    <ul className="text-xs text-fg-2 space-y-1">
                      <li>• Session completes (task finished)</li>
                      <li>• Permission requests (Claude needs approval)</li>
                      <li>• Works on mobile PWA and desktop browsers</li>
                    </ul>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Error message */}
          {error && (
            <p className="text-xs text-rose-300">{error}</p>
          )}
        </div>

        {/* Actions. Providers, API Keys, Access and Notify save as you go, so
            they close with Done; only the tabs with a form get Cancel/Save. */}
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
