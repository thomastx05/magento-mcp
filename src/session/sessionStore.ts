/**
 * In-memory session store.
 * Stores Magento admin tokens and session context per session.
 */

import { StoreScope } from '../protocol/types';
import { OAuthCredentials } from '../client/magentoRest';

export interface SessionData {
  sessionId: string;
  baseUrl: string;
  token: string;
  username: string;
  defaultScope: StoreScope | null;
  createdAt: string;
  oauth: OAuthCredentials | null;
}

export class SessionStore {
  private sessions = new Map<string, SessionData>();

  create(sessionId: string, baseUrl: string, token: string, username: string): SessionData {
    const session: SessionData = {
      sessionId,
      baseUrl,
      token,
      username,
      defaultScope: null,
      createdAt: new Date().toISOString(),
      oauth: null,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  createOAuth(sessionId: string, baseUrl: string, oauthCreds: OAuthCredentials, username: string): SessionData {
    const session: SessionData = {
      sessionId,
      baseUrl,
      token: 'oauth',
      username,
      defaultScope: null,
      createdAt: new Date().toISOString(),
      oauth: oauthCreds,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): SessionData | undefined {
    return this.sessions.get(sessionId);
  }

  setDefaultScope(sessionId: string, scope: StoreScope): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.defaultScope = scope;
    }
  }

  destroy(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  getToken(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.token ?? null;
  }

  getBaseUrl(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.baseUrl ?? null;
  }

  getUsername(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.username ?? null;
  }

  getDefaultScope(sessionId: string): StoreScope | null {
    return this.sessions.get(sessionId)?.defaultScope ?? null;
  }

  getOAuthCredentials(sessionId: string): OAuthCredentials | null {
    return this.sessions.get(sessionId)?.oauth ?? null;
  }
}
