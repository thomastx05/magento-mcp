/**
 * Auth actions: login, logout, whoami.
 */

import { ActionDefinition, ActionContext, RiskTier, ErrorCodes } from '../protocol/types';
import { AuthLoginSchema } from '../validation/schemas';
import { MagentoRestClient, OAuthCredentials } from '../client/magentoRest';
import { SessionStore } from '../session/sessionStore';

export function createAuthActions(sessionStore: SessionStore): ActionDefinition[] {
  return [
    {
      name: 'auth.login',
      description: 'Authenticate with Magento Admin credentials and establish a session.',
      riskTier: RiskTier.Safe,
      requiresAuth: false,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = AuthLoginSchema.parse(params);

        const base_url = validated.base_url || process.env.MAGENTO_BASE_URL;
        if (!base_url) {
          return { error: { code: 'VALIDATION_ERROR', message: 'base_url is required — pass it in params or set MAGENTO_BASE_URL env var' } };
        }

        // Check for OAuth 1.0 integration credentials first (bypasses 2FA)
        const oauthConsumerKey = (params['oauth_consumer_key'] as string) || process.env.MAGENTO_OAUTH_CONSUMER_KEY;
        const oauthConsumerSecret = (params['oauth_consumer_secret'] as string) || process.env.MAGENTO_OAUTH_CONSUMER_SECRET;
        const oauthToken = (params['oauth_token'] as string) || process.env.MAGENTO_OAUTH_TOKEN;
        const oauthTokenSecret = (params['oauth_token_secret'] as string) || process.env.MAGENTO_OAUTH_TOKEN_SECRET;

        if (oauthConsumerKey && oauthConsumerSecret && oauthToken && oauthTokenSecret) {
          const oauthCreds: OAuthCredentials = {
            consumerKey: oauthConsumerKey,
            consumerSecret: oauthConsumerSecret,
            token: oauthToken,
            tokenSecret: oauthTokenSecret,
          };
          const username = validated.username || process.env.MAGENTO_ADMIN_USERNAME || 'integration';
          sessionStore.createOAuth(context.sessionId, base_url, oauthCreds, username);
          return {
            message: 'Login successful (OAuth 1.0 integration)',
            username: username,
            base_url: base_url,
            auth_method: 'oauth',
          };
        }

        // Check for integration bearer token (bypasses 2FA)
        const integrationToken = (params['integration_token'] as string) || process.env.MAGENTO_INTEGRATION_TOKEN;
        if (integrationToken) {
          const username = validated.username || process.env.MAGENTO_ADMIN_USERNAME || 'integration';
          sessionStore.create(context.sessionId, base_url, integrationToken, username);
          return {
            message: 'Login successful (integration token)',
            username: username,
            base_url: base_url,
            auth_method: 'integration_token',
          };
        }

        // Fall back to username/password login
        const username = validated.username || process.env.MAGENTO_ADMIN_USERNAME;
        if (!username) {
          return { error: { code: 'VALIDATION_ERROR', message: 'username is required — pass it in params or set MAGENTO_ADMIN_USERNAME env var' } };
        }

        const password = validated.password || process.env.MAGENTO_ADMIN_PASSWORD;
        if (!password) {
          return { error: { code: 'VALIDATION_ERROR', message: 'password is required — pass it in params or set MAGENTO_ADMIN_PASSWORD env var' } };
        }

        const client = new MagentoRestClient(base_url);
        const token = await client.getAdminToken(username, password);

        sessionStore.create(context.sessionId, base_url, token, username);

        return {
          message: 'Login successful',
          username: username,
          base_url: base_url,
          auth_method: 'admin_token',
        };
      },
    },
    {
      name: 'auth.logout',
      description: 'Destroy the current session.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (_params: Record<string, unknown>, context: ActionContext) => {
        const destroyed = sessionStore.destroy(context.sessionId);
        return {
          message: destroyed ? 'Logged out successfully' : 'No active session',
        };
      },
    },
    {
      name: 'auth.whoami',
      description: 'Return current admin user info for the active session.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (_params: Record<string, unknown>, context: ActionContext) => {
        const token = context.getToken();
        const baseUrl = context.getBaseUrl();

        if (!token || !baseUrl) {
          return { error: { code: ErrorCodes.NOT_AUTHENTICATED, message: 'No active session' } };
        }

        // Try to get current admin user info from Magento
        try {
          const client = context.getClient();
          const userInfo = await client.get('/V1/users/me');
          return userInfo;
        } catch {
          // If the endpoint isn't available, return what we know
          return {
            username: context.username,
            base_url: baseUrl,
            default_scope: context.getDefaultScope(),
          };
        }
      },
    },
  ];
}
