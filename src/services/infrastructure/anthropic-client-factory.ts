import Anthropic from '@anthropic-ai/sdk';
import { createLogger, type Logger } from './logger.js';
import { ConfigService } from './config-service.js';

interface FactoryState {
  mode: 'none' | 'byok';
}

/**
 * The Anthropic client for Lattice's own generation features (summaries,
 * quick answers, insights). Uses the API key from config or ANTHROPIC_API_KEY;
 * with neither, those features are unavailable.
 */
export class AnthropicClientFactory {
  private static instance: AnthropicClientFactory;

  private logger: Logger;
  private client: Anthropic | null = null;
  private clientApiKey: string | null = null;
  private lastLoggedMode: FactoryState['mode'] | null = null;

  private constructor() {
    this.logger = createLogger('AnthropicClientFactory');
  }

  static getInstance(): AnthropicClientFactory {
    if (!AnthropicClientFactory.instance) {
      AnthropicClientFactory.instance = new AnthropicClientFactory();
    }
    return AnthropicClientFactory.instance;
  }

  getClient(): Anthropic | null {
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      this.client = null;
      this.clientApiKey = null;
      this.logModeChange('none');
      return null;
    }

    if (!this.client || this.clientApiKey !== apiKey) {
      this.client = new Anthropic({ apiKey });
      this.clientApiKey = apiKey;
      this.logModeChange('byok');
    }

    return this.client;
  }

  isConfigured(): boolean {
    return this.resolveApiKey() !== null;
  }

  getState(): FactoryState {
    return { mode: this.resolveApiKey() ? 'byok' : 'none' };
  }

  private resolveApiKey(): string | null {
    let configKey: string | undefined;
    try {
      configKey = ConfigService.getInstance().getConfig().anthropic?.apiKey?.trim();
    } catch {
      configKey = undefined;
    }
    return configKey || process.env.ANTHROPIC_API_KEY?.trim() || null;
  }

  private logModeChange(mode: FactoryState['mode']): void {
    if (this.lastLoggedMode === mode) return;
    this.lastLoggedMode = mode;
    if (mode === 'none') {
      this.logger.info('Anthropic client unavailable (no API key configured)');
      return;
    }
    this.logger.info('Anthropic client source selected', { mode });
  }
}

export const anthropicClientFactory = AnthropicClientFactory.getInstance();
