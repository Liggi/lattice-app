import type { ReleaseNote, UpdateStatus } from '@/types/update';
import type {
  CommandsResponse,
  FileSystemListQuery,
  FileSystemListResponse,
} from '../../types';
import { TeamsApi } from './teams-api';
import type { AppConfig, TailscaleServeAdvice } from './types';

const COMMANDS_CACHE_TTL_MS = 15_000;
const COMMANDS_CACHE_KEY_PREFIX = 'config:commands:';
const DIRECTORY_LIST_CACHE_TTL_MS = 10_000;
const DIRECTORY_LIST_CACHE_KEY_PREFIX = 'config:directory-list:';
const WEB_PUSH_STATUS_CACHE_TTL_MS = 60_000;
const WEB_PUSH_STATUS_CACHE_KEY = 'config:web-push-status';

export class ConfigApi extends TeamsApi {
  async listDirectory(params: FileSystemListQuery): Promise<FileSystemListResponse> {
    const searchParams = new URLSearchParams();
    searchParams.append('path', params.path);
    if (params.recursive !== undefined) searchParams.append('recursive', params.recursive.toString());
    if (params.respectGitignore !== undefined) searchParams.append('respectGitignore', params.respectGitignore.toString());

    const query = searchParams.toString();
    const cacheKey = `${DIRECTORY_LIST_CACHE_KEY_PREFIX}${query}`;
    return this.cachedGet(cacheKey, DIRECTORY_LIST_CACHE_TTL_MS, () => this.apiCall(`/api/filesystem/list?${query}`));
  }

  async getCommands(workingDirectory?: string): Promise<CommandsResponse> {
    const searchParams = new URLSearchParams();
    if (workingDirectory) {
      searchParams.append('workingDirectory', workingDirectory);
    }

    const query = searchParams.toString();
    const cacheKey = `${COMMANDS_CACHE_KEY_PREFIX}${workingDirectory || ''}`;
    return this.cachedGet(cacheKey, COMMANDS_CACHE_TTL_MS, () => this.apiCall(`/api/system/commands?${query}`));
  }

  async readFile(path: string): Promise<{ content: string }> {
    const searchParams = new URLSearchParams();
    searchParams.append('path', path);
    return this.apiCall(`/api/filesystem/read?${searchParams}`);
  }

  async checkAnthropicCredits(): Promise<{ creditsExhausted: boolean; healthStatus?: string }> {
    return this.apiCall('/api/system/check-credits', { method: 'POST' });
  }

  async getConfig(): Promise<AppConfig> {
    return this.apiCall<AppConfig>('/api/config');
  }

  /** Looks for Tailscale again; it may have started after the server did. */
  async detectTailscale(): Promise<{ tailscaleIp: string | null; tailscaleCli: string | null; tailscaleServe: TailscaleServeAdvice | null }> {
    return this.apiCall('/api/config/tailscale');
  }

  async updateConfig(updates: AppConfig): Promise<AppConfig> {
    return this.apiCall<AppConfig>('/api/config', {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async getWebPushStatus(): Promise<{ enabled: boolean; subscriptionCount: number; hasPublicKey: boolean; publicKey?: string }> {
    return this.cachedGet(
      WEB_PUSH_STATUS_CACHE_KEY,
      WEB_PUSH_STATUS_CACHE_TTL_MS,
      () => this.apiCall('/api/notifications/status')
    );
  }

  async registerWebPush(subscription: PushSubscription): Promise<{ success: boolean }> {
    return this.apiCall('/api/notifications/register', {
      method: 'POST',
      body: JSON.stringify(subscription),
    });
  }

  async unregisterWebPush(endpoint: string): Promise<{ success: boolean }> {
    return this.apiCall('/api/notifications/unregister', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    });
  }

  async sendTestNotification(): Promise<{ success: boolean; sent: number; failed: number }> {
    return this.apiCall('/api/notifications/test', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  exportLogs(minutes = 10): void {
    window.open(`/api/logs/export?minutes=${minutes}`, '_blank');
  }

  async getUpdateStatus(): Promise<UpdateStatus> {
    return this.apiCall('/api/update');
  }

  async getReleaseNotes(): Promise<{ notes: ReleaseNote[] }> {
    return this.apiCall('/api/update/notes', { timeout: 20_000 });
  }

  async startUpdate(): Promise<UpdateStatus> {
    return this.apiCall('/api/update', { method: 'POST', body: '{}' });
  }
}
