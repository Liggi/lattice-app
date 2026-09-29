import { LatticeError } from '../../types/index.js';
import { contextWindowProblem, endpointModelProblem } from '../../constants/claude-endpoint.js';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { LatticeConfig, DEFAULT_CONFIG, InterfaceConfig, ServerConfig } from '@/types/config.js';
import { CONFIG_DIR } from '@/utils/constants.js';
import { createLogger, type Logger } from '../infrastructure/logger.js';
import { EventEmitter } from 'events';
import { parseJson } from '../../utils/json.js';
import { readTailscaleServeStatus, tailscaleServeAdvice, type TailscaleServeAdvice, type TailscaleServeStatus } from '../../utils/tailscale-serve.js';

/**
 * Where the Tailscale CLI lives. The Mac App Store app keeps it inside the app
 * bundle and never puts it on PATH; the Standalone app adds /usr/local/bin only
 * if you opt in; Homebrew's /opt/homebrew/bin is missing from a service's PATH.
 */
const TAILSCALE_CLI_CANDIDATES = [
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
];

function readTailscaleIp(cli: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cli, ['ip', '-4'], { timeout: 3000 }, (error, stdout) => {
      const ip = error ? '' : stdout.trim().split('\n')[0];
      resolve(ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null);
    });
  });
}

/**
 * ConfigService manages Lattice configuration
 * Loads from ~/.lattice/config.json
 * Creates default config on first run
 */
export class ConfigService {
  private static instance: ConfigService;
  private static overrideConfigDir?: string;
  private config: LatticeConfig | null = null;
  private logger: Logger;
  private configPath: string;
  private configDir: string;
  private emitter: EventEmitter = new EventEmitter();
  private watcher?: import('fs').FSWatcher;
  private debounceTimer?: NodeJS.Timeout;
  private lastLoadedRaw?: string;
  private pollInterval?: NodeJS.Timeout;
  /** Runtime-only overrides (not persisted to config file) */
  private runtimeOverrides: { cwd?: string; tailscaleIp?: string | null; tailscaleCli?: string | null; serverPort?: number } = {};
  /** What Tailscale already serves, as of the last detection. */
  private tailscaleServeStatus: TailscaleServeStatus | null = null;

  private constructor() {
    this.logger = createLogger('ConfigService');
    this.configDir = ConfigService.overrideConfigDir || CONFIG_DIR;
    this.configPath = path.join(this.configDir, 'config.json');
  }

  /**
   * Set config directory override (for testing)
   * Must be called before getInstance()
   */
  static setConfigDir(dir: string): void {
    ConfigService.overrideConfigDir = dir;
  }

  /**
   * Get singleton instance
   */
  static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  /**
   * Initialize configuration
   * Creates config file if it doesn't exist
   * Throws error if initialization fails
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing configuration', { configPath: this.configPath });

    try {
      // Runtime startup monitor: ensure a config file exists before any
      // dependent service reads configuration values.
      await this.ensureConfigFilePresent();

      // Load and validate config
      await this.loadConfig();

      // Detect Tailscale IP (best-effort)
      await this.detectTailscale();

      // Start watching for external changes
      this.startWatching();
    } catch (error) {
      this.logger.error('Failed to initialize configuration', error);
      throw new Error(`Configuration initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Ensure the config file exists at startup.
   * Auto-creates default config when missing and logs a clear warning.
   */
  private async ensureConfigFilePresent(): Promise<void> {
    if (fs.existsSync(this.configPath)) {
      return;
    }

    await this.createDefaultConfig();
    this.logger.warn('Configuration file was missing at startup and has been auto-created with defaults', {
      path: this.configPath,
    });
  }

  /**
   * Get current configuration
   * Throws if not initialized
   */
  getConfig(): LatticeConfig & { server: { cwd?: string; tailscaleIp?: string; tailscaleCli?: string; tailscaleServe?: TailscaleServeAdvice } } {
    if (!this.config) {
      throw new Error('Configuration not initialized. Call initialize() first.');
    }
    // Merge runtime overrides (cwd, tailscaleIp) into the server config
    const port = this.runtimeOverrides.serverPort ?? this.config.server.port;
    const { tailscaleIp, tailscaleCli } = this.runtimeOverrides;
    return {
      ...this.config,
      server: {
        ...this.config.server,
        ...(this.runtimeOverrides.serverPort !== undefined && { port: this.runtimeOverrides.serverPort }),
        ...(this.runtimeOverrides.cwd && { cwd: this.runtimeOverrides.cwd }),
        ...(tailscaleIp && { tailscaleIp }),
        ...(tailscaleCli && { tailscaleCli, tailscaleServe: tailscaleServeAdvice(this.tailscaleServeStatus, tailscaleCli, port) })
      }
    };
  }

  /**
   * Set the working directory where lattice was invoked from
   * This is a runtime-only value, not persisted to config file
   */
  setInvocationCwd(cwd: string): void {
    this.runtimeOverrides.cwd = cwd;
    this.logger.debug('Set invocation cwd', { cwd });
  }

  /**
   * Set the actual runtime server port for this process.
   * This is not persisted; it lets runtime helpers avoid stale config-file ports.
   */
  setRuntimeServerPort(port: number): void {
    this.runtimeOverrides.serverPort = port;
    this.logger.debug('Set runtime server port', { port });
  }

  /**
   * Detect the Tailscale IPv4 address, the CLI that answered and what it
   * already serves (best-effort), and cache them for the frontend. Re-run when
   * the Access tab opens, so Tailscale started after the server is still found.
   */
  async detectTailscale(): Promise<{ tailscaleIp: string | null; tailscaleCli: string | null; tailscaleServe: TailscaleServeAdvice | null }> {
    for (const cli of TAILSCALE_CLI_CANDIDATES) {
      const ip = await readTailscaleIp(cli);
      if (ip) {
        if (ip !== this.runtimeOverrides.tailscaleIp) this.logger.info('Detected Tailscale IP', { ip, cli });
        this.runtimeOverrides.tailscaleIp = ip;
        this.runtimeOverrides.tailscaleCli = cli;
        this.tailscaleServeStatus = await readTailscaleServeStatus(cli);
        return { tailscaleIp: ip, tailscaleCli: cli, tailscaleServe: this.getConfig().server.tailscaleServe ?? null };
      }
    }
    this.runtimeOverrides.tailscaleIp = null;
    this.runtimeOverrides.tailscaleCli = null;
    this.tailscaleServeStatus = null;
    this.logger.debug('Tailscale not available');
    return { tailscaleIp: null, tailscaleCli: null, tailscaleServe: null };
  }

  /**
   * Create default configuration
   */
  private async createDefaultConfig(): Promise<void> {
    this.logger.info('Creating default configuration');

    try {
      // Ensure config directory exists
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
        this.logger.debug('Created config directory', { dir: this.configDir });
      }

      // Create default config
      const config: LatticeConfig = { ...DEFAULT_CONFIG };

      // Write config file
      fs.writeFileSync(
        this.configPath,
        JSON.stringify(config, null, 2),
        'utf-8'
      );

      this.logger.info('Default configuration created', { path: this.configPath });
    } catch (error) {
      throw new Error(`Failed to create default config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Load configuration from file
   */
  private async loadConfig(): Promise<void> {
    try {
      const configData = fs.readFileSync(this.configPath, 'utf-8');
      let fileConfig: Partial<LatticeConfig>;
      try {
        fileConfig = parseJson(configData) as Partial<LatticeConfig>;
      } catch (_parseError) {
        // Corrupted JSON should fail startup
        throw new Error('Invalid JSON in configuration file');
      }

      // Validate provided fields (strict for provided keys, allow missing)
      this.validateProvidedFields(fileConfig);

      // Merge with defaults for missing sections while preserving all existing fields
      let updated = false;
      const merged: LatticeConfig = {
        // Start with defaults
        ...DEFAULT_CONFIG,
        // Bring over everything from file (including optional fields like gemini)
        ...fileConfig,
        // Deep-merge known nested sections to ensure defaults are filled without dropping user values
        server: { ...DEFAULT_CONFIG.server, ...(fileConfig.server || {}) },
        interface: { ...DEFAULT_CONFIG.interface, ...(fileConfig.interface || {}) },
        messageLifecycle: { ...DEFAULT_CONFIG.messageLifecycle, ...(fileConfig.messageLifecycle || {}) },
      };

      // Determine if we added any defaults and need to persist back to disk
      if (!fileConfig.server || JSON.stringify(merged.server) !== JSON.stringify(fileConfig.server)) updated = true;
      if (!fileConfig.interface || JSON.stringify(merged.interface) !== JSON.stringify(fileConfig.interface)) updated = true;
      if (!fileConfig.messageLifecycle || JSON.stringify(merged.messageLifecycle) !== JSON.stringify(fileConfig.messageLifecycle)) updated = true;

      // Final validation on fully merged config
      this.validateCompleteConfig(merged);

      this.config = merged;
      this.lastLoadedRaw = JSON.stringify(this.config, null, 2);
      if (updated) {
        fs.writeFileSync(this.configPath, this.lastLoadedRaw, { encoding: 'utf-8', mode: 0o600 });
      fs.chmodSync(this.configPath, 0o600);
        this.logger.info('Configuration updated with defaults');
      }
      this.logger.debug('Configuration loaded successfully');
    } catch (error) {
      throw new Error(`Failed to load config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }


  /**
   * Update configuration
   */
  async updateConfig(updates: Partial<LatticeConfig>): Promise<void> {
    if (!this.config) {
      throw new Error('Configuration not initialized');
    }

    // Field names only: an update can carry an API key.
    this.logger.info('Updating configuration', {
      sections: Object.fromEntries(Object.entries(updates).map(([section, value]) => [
        section,
        value && typeof value === 'object' ? Object.keys(value as object) : typeof value,
      ])),
    });

    // Checked here, not on load: a hand-edited mistake must not stop the server
    // starting, and the daemon skips an endpoint it cannot use.
    if (updates.claudeEndpoints !== undefined) {
      this.assertClaudeEndpoints(updates.claudeEndpoints);
    }

    // Pick up any write we missed before merging; merging over a stale in-memory
    // copy writes the other process's change back out.
    this.handleExternalChange();

    // Create a new config via deep-merge semantics so unrelated options are preserved
    const current = this.config;

    const mergedServer = updates.server ? { ...current.server, ...updates.server } : current.server;

    const mergedInterface = updates.interface
      ? {
          ...current.interface,
          ...updates.interface,
          // Deep-merge nested notifications object if provided
          notifications:
            updates.interface.notifications !== undefined
              ? { ...(current.interface.notifications || {}), ...updates.interface.notifications }
              : current.interface.notifications
        }
      : current.interface;

    const mergedGemini = updates.gemini
      ? { ...(current.gemini || {}), ...updates.gemini }
      : current.gemini;

    const mergedAnthropic = updates.anthropic
      ? { ...(current.anthropic || {}), ...updates.anthropic }
      : current.anthropic;

    const mergedMessageLifecycle = updates.messageLifecycle
      ? { ...(current.messageLifecycle || {}), ...updates.messageLifecycle }
      : current.messageLifecycle;

    // Preserve unknown top-level keys (for optional integrations like x) when
    // callers provide partial updates outside the core LatticeConfig surface.
    const knownTopLevelKeys = new Set([
      'server',
      'interface',
      'gemini',
      'anthropic',
      'messageLifecycle',
      'plugins',
    ]);
    const passthroughUpdates = Object.fromEntries(
      Object.entries(updates as Record<string, unknown>).filter(([key]) => !knownTopLevelKeys.has(key))
    );

    // Preserve machine_id and authToken regardless of updates
    const newConfig: LatticeConfig & Record<string, unknown> = {
      ...current,
      ...passthroughUpdates,
      server: mergedServer,
      interface: mergedInterface,
      gemini: mergedGemini,
      anthropic: mergedAnthropic,
      messageLifecycle: mergedMessageLifecycle,
    };

    // Update in-memory config
    const prev = this.config;
    this.config = newConfig as LatticeConfig;
    
    // Write to file
    try {
      this.lastLoadedRaw = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(this.configPath, this.lastLoadedRaw, { encoding: 'utf-8', mode: 0o600 });
      fs.chmodSync(this.configPath, 0o600);
      this.logger.info('Configuration updated successfully');
      // Emit change event for internal updates
      this.emitter.emit('config-changed', this.config, prev, 'internal');
    } catch (error) {
      this.logger.error('Failed to update configuration', error);
      throw new Error(`Failed to update config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Subscribe to configuration changes
   */
  onChange(listener: (newConfig: LatticeConfig, previous: LatticeConfig | null, source: 'internal' | 'external') => void): void {
    this.emitter.on('config-changed', listener);
  }

  /**
   * Validate provided fields in a partial config. Throws on incompatible values.
   */
  private validateProvidedFields(partial: Partial<LatticeConfig>): void {
    // server
    if (partial.server) {
      this.assertServerConfig(partial.server);
    }
    // interface
    if (partial.interface) {
      this.assertInterfaceConfig(partial.interface);
    }
    // gemini (optional)
    if (partial.gemini) {
      if (partial.gemini.apiKey !== undefined && typeof partial.gemini.apiKey !== 'string') {
        throw new Error('Invalid config: gemini.apiKey must be a string');
      }
      if (partial.gemini.model !== undefined && typeof partial.gemini.model !== 'string') {
        throw new Error('Invalid config: gemini.model must be a string');
      }
    }
    // openai (optional)
    if (partial.openai) {
      if (partial.openai.apiKey !== undefined && typeof partial.openai.apiKey !== 'string') {
        throw new Error('Invalid config: openai.apiKey must be a string');
      }
      if (partial.openai.model !== undefined && typeof partial.openai.model !== 'string') {
        throw new Error('Invalid config: openai.model must be a string');
      }
    }
    // anthropic (optional)
    if (partial.anthropic) {
      if (partial.anthropic.apiKey !== undefined && typeof partial.anthropic.apiKey !== 'string') {
        throw new Error('Invalid config: anthropic.apiKey must be a string');
      }
      if (partial.anthropic.model !== undefined && typeof partial.anthropic.model !== 'string') {
        throw new Error('Invalid config: anthropic.model must be a string');
      }
    }
    if (partial.messageLifecycle) {
      this.assertMessageLifecycleConfig(partial.messageLifecycle);
    }
  }

  /**
   * Validate a complete merged config before using it. Throws on error.
   */
  private validateCompleteConfig(config: LatticeConfig): void {
    this.assertServerConfig(config.server);
    if (config.interface) {
      this.assertInterfaceConfig(config.interface);
    }
    if (config.messageLifecycle) {
      this.assertMessageLifecycleConfig(config.messageLifecycle);
    }
  }

  private assertClaudeEndpoints(endpoints: unknown): void {
    if (!Array.isArray(endpoints)) throw new LatticeError('INVALID_CONFIG', 'claudeEndpoints must be a list', 400);
    const models: string[] = [];
    for (const endpoint of endpoints as Array<Record<string, unknown>>) {
      for (const field of ['id', 'baseUrl', 'model'] as const) {
        if (typeof endpoint?.[field] !== 'string' || !(endpoint[field] as string).trim()) {
          throw new LatticeError('INVALID_CONFIG', `Each endpoint needs a ${field}`, 400);
        }
      }
      if (endpoint.apiKey !== undefined && typeof endpoint.apiKey !== 'string') {
        throw new LatticeError('INVALID_CONFIG', 'An endpoint key must be a string', 400);
      }
      const windowProblem = contextWindowProblem(endpoint.contextWindow);
      if (windowProblem) throw new LatticeError('INVALID_CONFIG', windowProblem, 400);
      if (!/^https?:\/\/[^/\s]+/.test((endpoint.baseUrl as string).trim())) {
        throw new LatticeError('INVALID_CONFIG', `The server URL must start with http:// or https:// (got ${endpoint.baseUrl as string})`, 400);
      }
      const problem = endpointModelProblem(endpoint.model as string, models);
      if (problem) throw new LatticeError('INVALID_CONFIG', problem, 400);
      models.push((endpoint.model as string).trim());
    }
  }

  private assertServerConfig(server: Partial<ServerConfig>): void {
    if (server.host !== undefined && typeof server.host !== 'string') {
      throw new Error('Invalid config: server.host must be a string');
    }
    if (server.port !== undefined && typeof server.port !== 'number') {
      throw new Error('Invalid config: server.port must be a number');
    }
    if (server.defaultModel !== undefined && typeof server.defaultModel !== 'string') {
      throw new Error('Invalid config: server.defaultModel must be a string');
    }
  }

  private assertMessageLifecycleConfig(
    lifecycle: {
      enabled?: unknown;
      hotRetentionDays?: unknown;
      archiveCompression?: unknown;
      pruneEnabled?: unknown;
      batchSize?: unknown;
      intervalMinutes?: unknown;
    } | undefined,
  ): void {
    if (!lifecycle) return;

    if (lifecycle.enabled !== undefined && typeof lifecycle.enabled !== 'boolean') {
      throw new Error('Invalid config: messageLifecycle.enabled must be a boolean');
    }
    if (lifecycle.hotRetentionDays !== undefined && (
      typeof lifecycle.hotRetentionDays !== 'number'
      || !Number.isFinite(lifecycle.hotRetentionDays)
      || lifecycle.hotRetentionDays < 1
    )) {
      throw new Error('Invalid config: messageLifecycle.hotRetentionDays must be a positive number');
    }
    if (lifecycle.archiveCompression !== undefined && typeof lifecycle.archiveCompression !== 'boolean') {
      throw new Error('Invalid config: messageLifecycle.archiveCompression must be a boolean');
    }
    if (lifecycle.pruneEnabled !== undefined && typeof lifecycle.pruneEnabled !== 'boolean') {
      throw new Error('Invalid config: messageLifecycle.pruneEnabled must be a boolean');
    }
    if (lifecycle.batchSize !== undefined && (
      typeof lifecycle.batchSize !== 'number'
      || !Number.isFinite(lifecycle.batchSize)
      || lifecycle.batchSize < 1
    )) {
      throw new Error('Invalid config: messageLifecycle.batchSize must be a positive number');
    }
    if (lifecycle.intervalMinutes !== undefined && (
      typeof lifecycle.intervalMinutes !== 'number'
      || !Number.isFinite(lifecycle.intervalMinutes)
      || lifecycle.intervalMinutes < 1
    )) {
      throw new Error('Invalid config: messageLifecycle.intervalMinutes must be a positive number');
    }
  }

  private assertInterfaceConfig(iface: Partial<InterfaceConfig>): void {
    if (iface.colorScheme !== undefined && !['light', 'dark', 'system'].includes(iface.colorScheme as string)) {
      throw new Error("Invalid config: interface.colorScheme must be 'light' | 'dark' | 'system'");
    }
    if (iface.language !== undefined && typeof iface.language !== 'string') {
      throw new Error('Invalid config: interface.language must be a string');
    }
    if (iface.notifications !== undefined) {
      const n = iface.notifications as InterfaceConfig['notifications'];
      if (n && typeof n.enabled !== 'boolean') {
        throw new Error('Invalid config: interface.notifications.enabled must be a boolean');
      }
      if (n && n.ntfyUrl !== undefined && typeof n.ntfyUrl !== 'string') {
        throw new Error('Invalid config: interface.notifications.ntfyUrl must be a string');
      }
    }
  }

  private startWatching(): void {
    // Avoid multiple watchers in tests
    if (this.watcher) return;
    try {
      // Increase listeners to avoid noisy warnings in tests with many server instances
      this.emitter.setMaxListeners(0);

      if (process.env.NODE_ENV === 'test') {
        // Use active polling in tests to avoid fs watcher flakiness with fake timers
        this.pollInterval = setInterval(() => {
          try {
            const raw = fs.readFileSync(this.configPath, 'utf-8');
            if (!this.lastLoadedRaw || raw !== this.lastLoadedRaw) {
              // Debounce within polling
              if (this.debounceTimer) clearTimeout(this.debounceTimer);
              this.debounceTimer = setTimeout(() => this.handleExternalChange(), 10);
            }
          } catch (err) {
              this.logger.debug('Config poll read failed', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
        }, 50);
        this.logger.debug('Started interval polling for configuration changes (test mode)');
      } else {
        // Watch the directory, not the file. A tmp-file-plus-rename write from
        // another process gives the path a new inode, and a file watcher stays
        // attached to the old one and never fires again.
        const configFile = path.basename(this.configPath);
        this.watcher = fs.watch(this.configDir, { persistent: false }, (eventType, filename) => {
          if (eventType !== 'change' && eventType !== 'rename') return;
          if (filename !== null && filename !== configFile) return;
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => this.handleExternalChange(), 250);
        });
        this.logger.debug('Started watching configuration file for changes');
      }
    } catch (error) {
      this.logger.warn('Failed to start file watcher for configuration', error as Error);
    }
  }

  private handleExternalChange(): void {
    try {
      const newRaw = fs.readFileSync(this.configPath, 'utf-8');
      if (this.lastLoadedRaw && newRaw === this.lastLoadedRaw) {
        return; // No effective change
      }
      let parsed: Partial<LatticeConfig>;
      try {
        parsed = parseJson(newRaw) as Partial<LatticeConfig>;
      } catch (_e) {
        this.logger.error('Ignoring external config change due to invalid JSON');
        return;
      }
      // Validate provided fields strictly
      this.validateProvidedFields(parsed);
      // Merge and validate complete
      const current = this.config || { ...DEFAULT_CONFIG };
      const merged: LatticeConfig = {
        ...DEFAULT_CONFIG,
        ...current,
        ...parsed,
        server: { ...DEFAULT_CONFIG.server, ...(current.server || {}), ...(parsed.server || {}) },
        interface: { ...DEFAULT_CONFIG.interface, ...(current.interface || {}), ...(parsed.interface || {}) },
        gemini: parsed.gemini !== undefined ? (parsed.gemini as LatticeConfig['gemini']) : current.gemini,
        anthropic: parsed.anthropic !== undefined ? (parsed.anthropic as LatticeConfig['anthropic']) : current.anthropic,
        messageLifecycle: parsed.messageLifecycle !== undefined
          ? { ...(current.messageLifecycle || {}), ...parsed.messageLifecycle }
          : current.messageLifecycle,
      };
      this.validateCompleteConfig(merged);
      const prev = this.config;
      this.config = merged;
      this.lastLoadedRaw = JSON.stringify(merged, null, 2);
      this.logger.info('Configuration reloaded from external change');
      this.emitter.emit('config-changed', this.config, prev || null, 'external');
    } catch (error) {
      this.logger.error('Failed to handle external configuration change', error as Error);
    }
  }

  /**
   * Reset singleton instance (for testing)
   */
  static resetInstance(): void {
    ConfigService.instance = null as unknown as ConfigService;
    ConfigService.overrideConfigDir = undefined;
  }
}
