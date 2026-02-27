/**
 * Scope actions: list_websites_stores, set_default.
 */

import { ActionDefinition, ActionContext, RiskTier } from '../protocol/types';
import { ScopeSetDefaultSchema } from '../validation/schemas';
import { SessionStore } from '../session/sessionStore';

export function createScopeActions(sessionStore: SessionStore): ActionDefinition[] {
  return [
    {
      name: 'scope.list_websites_stores',
      description: 'List all websites, stores, and store views configured in Magento.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (_params: Record<string, unknown>, context: ActionContext) => {
        const client = context.getClient();

        // Fetch store configs to get websites/stores/views
        const storeConfigs = await client.get<unknown[]>('/V1/store/storeConfigs');
        const websites = await client.get<unknown[]>('/V1/store/websites');
        const storeGroups = await client.get<unknown[]>('/V1/store/storeGroups');
        const storeViews = await client.get<unknown[]>('/V1/store/storeViews');

        return {
          websites,
          store_groups: storeGroups,
          store_views: storeViews,
          store_configs: storeConfigs,
          default_scope: context.getDefaultScope(),
        };
      },
    },
    {
      name: 'scope.set_default',
      description: 'Set the default store view scope for the current session.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = ScopeSetDefaultSchema.parse(params);

        sessionStore.setDefaultScope(context.sessionId, {
          store_view_code: validated.store_view_code,
        });

        return {
          message: `Default scope set to store view: ${validated.store_view_code}`,
          store_view_code: validated.store_view_code,
        };
      },
    },
  ];
}
