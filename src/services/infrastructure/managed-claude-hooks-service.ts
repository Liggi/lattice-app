import os from 'os';
import path from 'path';
import { ClaudeSettingsService } from './claude-settings-service.js';
import { getHostIntegration } from './host-integration.js';
import { createLogger, type Logger } from './logger.js';

export interface ManagedClaudeHooksRuntime {
  baseUrl: string;
  authToken?: string;
}

export interface ManagedClaudeHooksSyncResult {
  permissionRequestChanged: boolean;
  preToolUseChanged: boolean;
  preCompactChanged: boolean;
}

export class ManagedClaudeHooksService {
  private logger: Logger;

  constructor(
    private settingsService: ClaudeSettingsService = ClaudeSettingsService.getInstance(),
    logger?: Logger
  ) {
    this.logger = logger ?? createLogger('ManagedClaudeHooksService');
  }

  ensureHooks(runtime: ManagedClaudeHooksRuntime): ManagedClaudeHooksSyncResult {
    // A server without host-integration authority is a fixture or an ad-hoc
    // dev run. It gets no hooks rather than an error: ensureHooks is called on
    // every conversation spawn, so throwing here would make such a server
    // unable to start a conversation at all. Warn once per call with the
    // reason, so the missing ASK-mode permissions are explained rather than
    // merely absent.
    //
    // Two callers, not one. LatticeServer calls this during startup as well,
    // via ensureManagedClaudeHooks in the init sequence, so the warning below
    // appears in a startup log with no conversation involved. Reasoning about
    // it from the spawn caller alone -- as an earlier version of this comment
    // invited -- gives the wrong answer about when a denial is visible, and
    // the absence of this line at startup is a real check that an instance
    // holds authority.
    const authority = getHostIntegration();
    if (!authority.manageClaudeSettings) {
      this.logger.warn(
        'Not managing shared Claude hooks for this instance; ASK-mode permissions will not reach it',
        { baseUrl: runtime.baseUrl, reason: authority.deniedReason, marker: authority.markerPath }
      );
      return {
        permissionRequestChanged: false,
        preToolUseChanged: false,
        preCompactChanged: false,
      };
    }

    // Batch the two HTTP hooks into a single read-lock-write cycle
    // (previously 2 separate cycles per spawn).
    const batchResults = this.settingsService.ensureHttpHooksBatch([
      {
        eventName: 'PermissionRequest',
        url: `${runtime.baseUrl}/api/permissions/hooks/permission-request`,
        managedHeaderName: 'X-Lattice-Permission-Hook',
        authToken: runtime.authToken,
      },
      {
        eventName: 'PreToolUse',
        url: `${runtime.baseUrl}/api/permissions/hooks/pre-tool-use`,
        managedHeaderName: 'X-Lattice-PreToolUse-Hook',
        authToken: runtime.authToken,
      },
      {
        eventName: 'PermissionDenied',
        url: `${runtime.baseUrl}/api/permissions/hooks/permission-denied`,
        managedHeaderName: 'X-Lattice-PermissionDenied-Hook',
        authToken: runtime.authToken,
      },
    ]);

    const permissionRequestChanged = batchResults['PermissionRequest'] ?? false;
    const preToolUseChanged = batchResults['PreToolUse'] ?? false;

    // PreCompact uses a command hook (not HTTP), requires separate handling
    const preCompactScriptPath = path.join(os.homedir(), '.claude', 'hooks', 'pre-compact-hook.sh');
    const preCompactChanged = this.settingsService.ensurePreCompactHook({
      scriptPath: preCompactScriptPath,
      endpointUrl: `${runtime.baseUrl}/api/permissions/hooks/compact`,
      authToken: runtime.authToken,
    });

    this.logger.debug('Ensured managed Claude hooks', {
      baseUrl: runtime.baseUrl,
      hasAuthToken: !!runtime.authToken,
      permissionRequestChanged,
      preToolUseChanged,
      preCompactChanged,
    });

    return {
      permissionRequestChanged,
      preToolUseChanged,
      preCompactChanged,
    };
  }
}
