export interface AuthResponse {
  user: {
    id: string;
    email: string;
    displayName: string;
  };
  accessToken: string;
  refreshToken: string;
}

export interface BootstrapResponse {
  matrixCredentials: {
    homeserver: string;
    userId: string;
    accessToken: string;
    deviceId: string;
  };
  gatewayUrl: string | null;
  gatewayToken: string | null;
  nodeDeviceKeyPem: string | null;
  cliNodeDeviceKeyPem: string | null;
}

export interface GatewayProvisionResponse {
  gatewayUrl: string;
  gatewayToken: string;
  nodeDeviceKeyPem: string;
  cliNodeDeviceKeyPem: string;
}

export class ProvisioningError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly networkError = false,
  ) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

export function isNetworkError(error: unknown): error is ProvisioningError {
  return error instanceof ProvisioningError && error.networkError;
}

export class ProvisioningClient {
  constructor(private readonly baseUrl: string) {}

  async login(email: string, password: string): Promise<AuthResponse> {
    return this.request<AuthResponse>('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  }

  async signup(email: string, password: string): Promise<AuthResponse> {
    return this.request<AuthResponse>('/v1/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  }

  async bootstrap(accessToken: string): Promise<BootstrapResponse> {
    return this.request<BootstrapResponse>('/v1/bootstrap', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }

  async provisionAgent(accessToken: string): Promise<GatewayProvisionResponse> {
    return this.request<GatewayProvisionResponse>('/v1/agent/provision', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    return this.request<{ accessToken: string; refreshToken: string }>('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  }

  async listAgents(accessToken: string): Promise<{ agents: Array<{ id: string; name: string; model: string | null }> }> {
    return this.request<{ agents: Array<{ id: string; name: string; model: string | null }> }>('/v1/agents', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }

  async createAgent(
    accessToken: string,
    data: { name: string; model?: string },
  ): Promise<{ id: string; name: string; model: string | null }> {
    return this.request<{ id: string; name: string; model: string | null }>('/v1/agents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(data),
    });
  }

  async updateAgent(
    accessToken: string,
    id: string,
    data: { name?: string; model?: string },
  ): Promise<{ id: string; name: string; model: string | null }> {
    return this.request<{ id: string; name: string; model: string | null }>(`/v1/agents/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(data),
    });
  }

  async deleteAgent(accessToken: string, id: string): Promise<void> {
    const url = this.buildUrl(`/v1/agents/${id}`);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
    } catch (error) {
      throw new ProvisioningError(
        `Network error calling Provisioning at ${url}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        true,
      );
    }

    if (!response.ok && response.status !== 204) {
      const details = await this.extractErrorMessage(response);
      throw new ProvisioningError(
        `Provisioning request failed (${response.status}): ${details}`,
        response.status,
      );
    }
  }

  async listModels(accessToken: string): Promise<{ models: Array<{ id: string; ownedBy: string }> }> {
    return this.request<{ models: Array<{ id: string; ownedBy: string }> }>('/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }

  async sendContactRequest(accessToken: string, email: string): Promise<unknown> {
    return this.request<unknown>('/v1/contacts/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ email }),
    });
  }

  async listContactRequests(accessToken: string): Promise<{ requests: Array<{ id: string; fromUserId: string; fromEmail: string; toUserId: string; toEmail: string; direction: 'incoming' | 'outgoing'; status: string; createdAt: string }> }> {
    return this.request<{ requests: Array<{ id: string; fromUserId: string; fromEmail: string; toUserId: string; toEmail: string; direction: 'incoming' | 'outgoing'; status: string; createdAt: string }> }>('/v1/contacts/requests', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }

  async acceptContactRequest(accessToken: string, requestId: string): Promise<unknown> {
    return this.request<unknown>('/v1/contacts/accept', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ requestId }),
    });
  }

  async rejectContactRequest(accessToken: string, requestId: string): Promise<void> {
    const url = this.buildUrl('/v1/contacts/reject');
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ requestId }),
      });
    } catch (error) {
      throw new ProvisioningError(
        `Network error calling Provisioning at ${url}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        true,
      );
    }

    if (response.status !== 204 && !response.ok) {
      const details = await this.extractErrorMessage(response);
      throw new ProvisioningError(
        `Provisioning request failed (${response.status}): ${details}`,
        response.status,
      );
    }
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const url = this.buildUrl(path);

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new ProvisioningError(
        `Network error calling Provisioning at ${url}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        true,
      );
    }

    if (!response.ok) {
      const details = await this.extractErrorMessage(response);
      throw new ProvisioningError(
        `Provisioning request failed (${response.status}): ${details}`,
        response.status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new ProvisioningError(`Invalid JSON response from Provisioning at ${url}`);
    }
  }

  private buildUrl(path: string): string {
    const normalizedBase = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl;
    return `${normalizedBase}${path}`;
  }

  private async extractErrorMessage(response: Response): Promise<string> {
    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      try {
        const payload = (await response.json()) as Record<string, unknown>;
        const message = payload.message ?? payload.error ?? payload.code;
        if (typeof message === 'string' && message.trim().length > 0) {
          return message;
        }
        return JSON.stringify(payload);
      } catch {
        return `HTTP ${response.status}`;
      }
    }

    try {
      const text = await response.text();
      return text.trim().length > 0 ? text : `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }

  async pieboxStatus(accessToken: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/v1/piebox/status', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  async pieboxEnsure(accessToken: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/v1/piebox/ensure', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  // --- Group Chat ---

  async createGroup(
    accessToken: string,
    memberMatrixUserIds: string[],
  ): Promise<{ roomId: string; roomName: string; failedMembers: string[] }> {
    return this.request<{ roomId: string; roomName: string; failedMembers: string[] }>('/v1/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ memberMatrixUserIds }),
    });
  }

  async inviteGroupMembers(
    accessToken: string,
    roomId: string,
    memberMatrixUserIds: string[],
  ): Promise<{ invited: string[]; failed: string[] }> {
    return this.request<{ invited: string[]; failed: string[] }>(`/v1/groups/${encodeURIComponent(roomId)}/members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ memberMatrixUserIds }),
    });
  }

  async removeGroupMember(
    accessToken: string,
    roomId: string,
    matrixUserId: string,
  ): Promise<void> {
    const url = this.buildUrl(`/v1/groups/${encodeURIComponent(roomId)}/members/${encodeURIComponent(matrixUserId)}`);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (error) {
      throw new ProvisioningError(
        `Network error calling Provisioning at ${url}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        true,
      );
    }
    if (response.status !== 204 && !response.ok) {
      const details = await this.extractErrorMessage(response);
      throw new ProvisioningError(
        `Provisioning request failed (${response.status}): ${details}`,
        response.status,
      );
    }
  }
}
