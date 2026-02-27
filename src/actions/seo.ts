/**
 * SEO actions: URL key management, meta updates, redirect chain reports.
 */

import { ActionDefinition, ActionContext, RiskTier } from '../protocol/types';
import {
  SeoPrepareBulkUrlKeysSchema,
  SeoCommitBulkUrlKeysSchema,
  SeoBulkUpdateMetaSchema,
  SeoRedirectChainsSchema,
} from '../validation/schemas';
import { MagentoRestClient } from '../client/magentoRest';
// Note: MagentoRestClient import kept for resolveProducts helper
import { PlanStore } from '../session/planStore';
import { Guardrails } from '../validation/guardrails';
import { McpConfig } from '../config';

export function createSeoActions(
  planStore: PlanStore,
  guardrails: Guardrails,
  config: McpConfig,
): ActionDefinition[] {
  return [
    // ── Prepare Bulk URL Key Update ───────────────────────────────────────
    {
      name: 'seo.prepare_bulk_update_url_keys',
      description: 'Prepare a bulk URL key update with collision validation and redirect plan.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = SeoPrepareBulkUrlKeysSchema.parse(params);
        const client = context.getClient();

        // Resolve products
        const products = await resolveProducts(client, validated.match, validated.scope?.store_view_code);
        guardrails.enforceBulkSkuCap(products.length);

        // Compute new URL keys and check for collisions
        const urlKeyChanges: Array<{ sku: string; old_url_key: string; new_url_key: string }> = [];
        const collisions: string[] = [];
        const existingUrlKeys = new Set(products.map((p) => String(p['url_key'] || '')));

        for (const product of products) {
          const oldKey = String(product['url_key'] || '');
          let newKey = oldKey;

          if (validated.url_key_transform.prefix) {
            newKey = validated.url_key_transform.prefix + newKey;
          }
          if (validated.url_key_transform.suffix) {
            newKey = newKey + validated.url_key_transform.suffix;
          }
          if (validated.url_key_transform.replace) {
            newKey = newKey.replace(
              validated.url_key_transform.replace.search,
              validated.url_key_transform.replace.replacement,
            );
          }

          // Check collision
          if (newKey !== oldKey && existingUrlKeys.has(newKey)) {
            collisions.push(`Collision: "${newKey}" already exists`);
          }

          urlKeyChanges.push({
            sku: String(product['sku']),
            old_url_key: oldKey,
            new_url_key: newKey,
          });
        }

        const warnings = [...collisions];
        if (products.length > 50) {
          warnings.push(`Large URL key update: ${products.length} products.`);
        }

        const plan = planStore.create(
          'seo.commit_bulk_update_url_keys',
          {
            changes: urlKeyChanges,
            scope: validated.scope,
          },
          products.length,
          config.planExpiryMinutes,
          urlKeyChanges.slice(0, 10),
          warnings,
        );

        return {
          plan_id: plan.plan_id,
          expires_at: plan.expires_at,
          affected_count: products.length,
          url_key_changes: urlKeyChanges.slice(0, 10),
          collisions: collisions.length > 0 ? collisions : undefined,
          warnings,
          message: 'URL key update plan created. Call seo.commit_bulk_update_url_keys to execute.',
        };
      },
    },

    // ── Commit Bulk URL Key Update ────────────────────────────────────────
    {
      name: 'seo.commit_bulk_update_url_keys',
      description: 'Execute a previously prepared bulk URL key update.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = SeoCommitBulkUrlKeysSchema.parse(params);
        guardrails.requireConfirmation(RiskTier.Risk, params);

        const plan = planStore.consume(validated.plan_id);
        if (!plan) {
          throw new Error('Plan not found or expired.');
        }

        const payload = plan.payload as {
          changes: Array<{ sku: string; new_url_key: string }>;
          scope: Record<string, string>;
        };

        const client = context.getClient();
        const storeCode = payload.scope?.store_view_code;

        let successCount = 0;
        const errors: Array<{ sku: string; error: string }> = [];

        for (const change of payload.changes) {
          try {
            await client.put(`/V1/products/${encodeURIComponent(change.sku)}`, {
              product: {
                sku: change.sku,
                custom_attributes: [
                  { attribute_code: 'url_key', value: change.new_url_key },
                ],
              },
            }, storeCode);
            successCount++;
          } catch (err) {
            errors.push({ sku: change.sku, error: err instanceof Error ? err.message : String(err) });
          }
        }

        return {
          message: `Updated URL keys for ${successCount}/${payload.changes.length} products.`,
          success_count: successCount,
          error_count: errors.length,
          errors: errors.length > 0 ? errors : undefined,
        };
      },
    },

    // ── Bulk Update Meta ──────────────────────────────────────────────────
    {
      name: 'seo.bulk_update_meta',
      description: 'Bulk update meta fields (title, description, keywords) for products.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = SeoBulkUpdateMetaSchema.parse(params);
        guardrails.requireConfirmation(RiskTier.Risk, params);

        const client = context.getClient();
        const products = await resolveProducts(client, validated.match, validated.scope?.store_view_code);
        guardrails.enforceBulkSkuCap(products.length);

        const storeCode = validated.scope?.store_view_code;
        let successCount = 0;
        const errors: Array<{ sku: string; error: string }> = [];

        for (const product of products) {
          const customAttributes: Array<{ attribute_code: string; value: string }> = [];

          if (validated.meta_updates.meta_title !== undefined) {
            customAttributes.push({ attribute_code: 'meta_title', value: validated.meta_updates.meta_title });
          }
          if (validated.meta_updates.meta_description !== undefined) {
            customAttributes.push({ attribute_code: 'meta_description', value: validated.meta_updates.meta_description });
          }
          if (validated.meta_updates.meta_keyword !== undefined) {
            customAttributes.push({ attribute_code: 'meta_keyword', value: validated.meta_updates.meta_keyword });
          }

          try {
            const sku = String(product['sku']);
            await client.put(`/V1/products/${encodeURIComponent(sku)}`, {
              product: { sku, custom_attributes: customAttributes },
            }, storeCode);
            successCount++;
          } catch (err) {
            errors.push({
              sku: String(product['sku']),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return {
          message: `Updated meta fields for ${successCount}/${products.length} products.`,
          success_count: successCount,
          error_count: errors.length,
          errors: errors.length > 0 ? errors : undefined,
        };
      },
    },

    // ── Report Redirect Chains ────────────────────────────────────────────
    {
      name: 'seo.report_redirect_chains',
      description: 'Report on URL redirect chains up to a configurable depth.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = SeoRedirectChainsSchema.parse(params);
        const client = context.getClient();

        // Fetch URL rewrites
        const searchParams = client.buildSearchParams({
          filterGroups: [
            { filters: [{ field: 'redirect_type', value: '0', conditionType: 'neq' }] },
          ],
          pageSize: 1000,
        });

        const result = await client.get<{ items: Array<Record<string, unknown>> }>(
          '/V1/url-rewrite',
          searchParams,
        ).catch(() => ({ items: [] as Array<Record<string, unknown>> }));

        const rewrites = result.items || [];

        // Build redirect map
        const redirectMap = new Map<string, string>();
        for (const rw of rewrites) {
          redirectMap.set(String(rw['request_path']), String(rw['target_path']));
        }

        // Find chains
        const chains: Array<{ start: string; chain: string[]; depth: number }> = [];
        for (const [start] of redirectMap) {
          const chain: string[] = [start];
          let current = start;
          let depth = 0;

          while (redirectMap.has(current) && depth < validated.max_depth) {
            current = redirectMap.get(current)!;
            chain.push(current);
            depth++;
          }

          if (chain.length > 2) {
            chains.push({ start, chain, depth: chain.length - 1 });
          }
        }

        return {
          total_redirects: rewrites.length,
          chains_found: chains.length,
          chains: chains.slice(0, 50),
          max_depth_checked: validated.max_depth,
        };
      },
    },
  ];
}

async function resolveProducts(
  client: MagentoRestClient,
  match: { sku_list?: string[]; sku_prefix?: string; attribute_filters?: Record<string, unknown>; category_id?: number },
  storeCode?: string,
): Promise<Array<Record<string, unknown>>> {
  const filterGroups: Array<{ filters: Array<{ field: string; value: string; conditionType?: string }> }> = [];

  if (match.sku_list && match.sku_list.length > 0) {
    filterGroups.push({
      filters: [{ field: 'sku', value: match.sku_list.join(','), conditionType: 'in' }],
    });
  }
  if (match.sku_prefix) {
    filterGroups.push({
      filters: [{ field: 'sku', value: `${match.sku_prefix}%`, conditionType: 'like' }],
    });
  }

  const searchParams = client.buildSearchParams({
    filterGroups: filterGroups.length > 0 ? filterGroups : undefined,
    pageSize: 2000,
  });

  const result = await client.get<{ items: Array<Record<string, unknown>> }>('/V1/products', searchParams, storeCode);
  return result.items || [];
}
