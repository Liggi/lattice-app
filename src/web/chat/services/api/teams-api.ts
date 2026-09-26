import { PermissionsApi } from './permissions-api';
import type { TeamInfoResponse } from './types';

export class TeamsApi extends PermissionsApi {
  async getTeamInfo(teamName: string): Promise<TeamInfoResponse> {
    return this.apiCall(`/api/teams/${encodeURIComponent(teamName)}`);
  }
}
