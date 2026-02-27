/**
 * Magento REST API client.
 * Wraps all HTTP calls to the Magento Admin REST API.
 * Uses native Node.js fetch (available in Node 18+).
 * Supports both Bearer token and OAuth 1.0 authentication.
 */

import * as crypto from 'crypto';

export interface OAuthCredentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

export interface MagentoSearchCriteria {
  filterGroups?: Array<{
    filters: Array<{
      field: string;
      value: string;
      conditionType?: string;
    }>;
  }>;
  sortOrders?: Array<{
    field: string;
    direction: 'ASC' | 'DESC';
  }>;
  pageSize?: number;
  currentPage?: number;
}

export interface MagentoApiError {
  message: string;
  parameters?: unknown[];
  trace?: string;
}

let nonceCounter = 0;

export class MagentoRestClient {
  private oauth: OAuthCredentials | null = null;

  constructor(
    private baseUrl: string,
    private token: string | null = null,
  ) {}

  setToken(token: string): void {
    this.token = token;
  }

  setOAuth(credentials: OAuthCredentials): void {
    this.oauth = credentials;
  }

  /**
   * Get an admin bearer token via username/password.
   */
  async getAdminToken(username: string, password: string): Promise<string> {
    const response = await this.post<string>(
      '/V1/integration/admin/token',
      { username, password },
      false,
    );
    return response;
  }

  /**
   * Perform a GET request against the Magento REST API.
   */
  async get<T = unknown>(endpoint: string, params?: Record<string, string>, storeCode?: string): Promise<T> {
    const baseUrl = this.buildBaseUrl(endpoint, storeCode);
    const url = this.appendQueryString(baseUrl, params);
    const response = await fetch(url, {
      method: 'GET',
      headers: this.authHeaders('GET', baseUrl, params),
    });
    return this.handleResponse<T>(response);
  }

  /**
   * Perform a POST request against the Magento REST API.
   */
  async post<T = unknown>(endpoint: string, body: unknown, requireAuth = true, storeCode?: string): Promise<T> {
    const baseUrl = this.buildBaseUrl(endpoint, storeCode);
    const headers = requireAuth ? this.authHeaders('POST', baseUrl) : this.baseHeaders();
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(response);
  }

  /**
   * Perform a PUT request against the Magento REST API.
   */
  async put<T = unknown>(endpoint: string, body: unknown, storeCode?: string): Promise<T> {
    const baseUrl = this.buildBaseUrl(endpoint, storeCode);
    const response = await fetch(baseUrl, {
      method: 'PUT',
      headers: this.authHeaders('PUT', baseUrl),
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(response);
  }

  /**
   * Perform a DELETE request against the Magento REST API.
   */
  async delete<T = unknown>(endpoint: string, storeCode?: string): Promise<T> {
    const baseUrl = this.buildBaseUrl(endpoint, storeCode);
    const response = await fetch(baseUrl, {
      method: 'DELETE',
      headers: this.authHeaders('DELETE', baseUrl),
    });
    return this.handleResponse<T>(response);
  }

  /**
   * Build a search criteria query string from structured criteria.
   */
  buildSearchParams(criteria: MagentoSearchCriteria): Record<string, string> {
    const params: Record<string, string> = {};

    if (criteria.filterGroups) {
      criteria.filterGroups.forEach((group, gi) => {
        group.filters.forEach((filter, fi) => {
          params[`searchCriteria[filterGroups][${gi}][filters][${fi}][field]`] = filter.field;
          params[`searchCriteria[filterGroups][${gi}][filters][${fi}][value]`] = filter.value;
          if (filter.conditionType) {
            params[`searchCriteria[filterGroups][${gi}][filters][${fi}][conditionType]`] = filter.conditionType;
          }
        });
      });
    }

    if (criteria.sortOrders) {
      criteria.sortOrders.forEach((sort, i) => {
        params[`searchCriteria[sortOrders][${i}][field]`] = sort.field;
        params[`searchCriteria[sortOrders][${i}][direction]`] = sort.direction;
      });
    }

    if (criteria.pageSize !== undefined) {
      params['searchCriteria[pageSize]'] = String(criteria.pageSize);
    }
    if (criteria.currentPage !== undefined) {
      params['searchCriteria[currentPage]'] = String(criteria.currentPage);
    }

    return params;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private buildBaseUrl(endpoint: string, storeCode?: string): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    const scope = storeCode ? `/${storeCode}` : '';
    return `${base}/rest${scope}${endpoint}`;
  }

  private appendQueryString(baseUrl: string, params?: Record<string, string>): string {
    if (!params || Object.keys(params).length === 0) return baseUrl;
    const qs = Object.entries(params)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    return baseUrl + '?' + qs;
  }

  private baseHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private authHeaders(method: string, baseUrl: string, queryParams?: Record<string, string>): Record<string, string> {
    if (this.oauth) {
      return {
        ...this.baseHeaders(),
        Authorization: this.buildOAuthHeader(method, baseUrl, queryParams),
      };
    }
    if (!this.token) {
      throw new Error('MagentoRestClient: No auth token or OAuth credentials set. Call auth.login first.');
    }
    return {
      ...this.baseHeaders(),
      Authorization: `Bearer ${this.token}`,
    };
  }

  private buildOAuthHeader(method: string, baseUrl: string, queryParams?: Record<string, string>): string {
    const oauth = this.oauth!;
    const nonce = crypto.randomBytes(32).toString('hex');
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // OAuth params
    const oauthParams: Record<string, string> = {
      oauth_consumer_key: oauth.consumerKey,
      oauth_nonce: nonce,
      oauth_signature_method: 'HMAC-SHA256',
      oauth_timestamp: timestamp,
      oauth_token: oauth.token,
      oauth_version: '1.0',
    };

    // Merge query params with OAuth params for signature base string
    const allParams: Record<string, string> = { ...oauthParams };
    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        allParams[key] = value;
      }
    }

    // Build signature base string (RFC 5849 Section 3.4.1)
    const paramString = Object.keys(allParams)
      .sort()
      .map(k => this.rfc3986Encode(k) + '=' + this.rfc3986Encode(allParams[k]))
      .join('&');

    const signatureBaseString = method.toUpperCase() + '&' +
      this.rfc3986Encode(baseUrl) + '&' +
      this.rfc3986Encode(paramString);

    // Sign
    const signingKey = this.rfc3986Encode(oauth.consumerSecret) + '&' + this.rfc3986Encode(oauth.tokenSecret);
    const signature = crypto.createHmac('sha256', signingKey).update(signatureBaseString).digest('base64');

    // Build Authorization header
    const authParams = { ...oauthParams, oauth_signature: signature };
    return 'OAuth ' + Object.entries(authParams)
      .map(([k, v]) => k + '="' + this.rfc3986Encode(v) + '"')
      .join(', ');
  }

  private rfc3986Encode(str: string): string {
    return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new MagentoApiException(response.status, text);
      }
      data = text;
    }

    if (!response.ok) {
      const apiError = data as MagentoApiError;
      throw new MagentoApiException(
        response.status,
        apiError?.message ?? text,
        apiError?.parameters,
      );
    }

    return data as T;
  }
}

export class MagentoApiException extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly parameters?: unknown[],
  ) {
    super(`Magento API Error (${statusCode}): ${message}`);
    this.name = 'MagentoApiException';
  }
}
