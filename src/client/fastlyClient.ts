/**
 * Fastly CDN client for targeted cache purge operations.
 * Uses the Fastly purge API.
 */

export class FastlyClient {
  constructor(
    private serviceId: string,
    private apiToken: string,
  ) {}

  /**
   * Purge a single URL from Fastly cache.
   */
  async purgeUrl(url: string): Promise<FastlyPurgeResult> {
    const response = await fetch(url, {
      method: 'PURGE',
      headers: {
        'Fastly-Key': this.apiToken,
      },
    });
    const data = await response.json() as Record<string, unknown>;
    return {
      status: response.status,
      id: data['id'] as string | undefined,
      ok: response.ok,
    };
  }

  /**
   * Purge by surrogate key (cache tag).
   */
  async purgeSurrogateKey(key: string): Promise<FastlyPurgeResult> {
    const url = `https://api.fastly.com/service/${this.serviceId}/purge/${key}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Fastly-Key': this.apiToken,
        Accept: 'application/json',
      },
    });
    const data = await response.json() as Record<string, unknown>;
    return {
      status: response.status,
      id: data['id'] as string | undefined,
      ok: response.ok,
    };
  }

  /**
   * Purge multiple surrogate keys.
   */
  async purgeSurrogateKeys(keys: string[]): Promise<FastlyPurgeResult> {
    const url = `https://api.fastly.com/service/${this.serviceId}/purge`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Fastly-Key': this.apiToken,
        'Surrogate-Key': keys.join(' '),
        Accept: 'application/json',
      },
    });
    const data = await response.json() as Record<string, unknown>;
    return {
      status: response.status,
      id: data['id'] as string | undefined,
      ok: response.ok,
    };
  }
}

export interface FastlyPurgeResult {
  status: number;
  id?: string;
  ok: boolean;
}
