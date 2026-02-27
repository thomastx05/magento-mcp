/**
 * Catalog actions: Product search, get, and bulk update (two-phase).
 */

import { ActionDefinition, ActionContext, RiskTier } from '../protocol/types';
import {
  CatalogSearchSchema,
  CatalogGetProductSchema,
  PrepareBulkUpdateSchema,
  CommitBulkUpdateSchema,
} from '../validation/schemas';
import { MagentoRestClient } from '../client/magentoRest';
// Note: MagentoRestClient import kept for resolveMatchingProducts helper
import { PlanStore } from '../session/planStore';
import { Guardrails } from '../validation/guardrails';
import { IdempotencyLedger } from '../session/idempotencyLedger';
import { McpConfig } from '../config';

export function createCatalogActions(
  planStore: PlanStore,
  guardrails: Guardrails,
  idempotencyLedger: IdempotencyLedger,
  config: McpConfig,
): ActionDefinition[] {
  return [
    // ── Search Products ───────────────────────────────────────────────────
    {
      name: 'catalog.search_products',
      description: 'Search products with filters, pagination, and optional scope.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = CatalogSearchSchema.parse(params);
        const client = context.getClient();

        const filterGroups: Array<{ filters: Array<{ field: string; value: string; conditionType?: string }> }> = [];

        if (validated.filters) {
          for (const [field, spec] of Object.entries(validated.filters)) {
            if (typeof spec === 'object' && spec !== null && !Array.isArray(spec)) {
              const s = spec as Record<string, string>;
              filterGroups.push({
                filters: [{ field, value: s['value'] || '', conditionType: s['condition'] || 'eq' }],
              });
            } else {
              filterGroups.push({
                filters: [{ field, value: String(spec), conditionType: 'eq' }],
              });
            }
          }
        }

        const searchParams = client.buildSearchParams({
          filterGroups: filterGroups.length > 0 ? filterGroups : undefined,
          pageSize: validated.page_size,
          currentPage: validated.current_page,
        });

        // Add fields projection if specified
        if (validated.fields && validated.fields.length > 0) {
          searchParams['fields'] = `items[${validated.fields.join(',')}],total_count,search_criteria`;
        }

        const storeCode = validated.scope?.store_view_code;
        const result = await client.get('/V1/products', searchParams, storeCode);
        return result;
      },
    },

    // ── Get Product ───────────────────────────────────────────────────────
    {
      name: 'catalog.get_product',
      description: 'Get full product details by SKU.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = CatalogGetProductSchema.parse(params);
        const client = context.getClient();
        const storeCode = validated.scope?.store_view_code;
        const result = await client.get(`/V1/products/${encodeURIComponent(validated.sku)}`, undefined, storeCode);
        return result;
      },
    },

    // ── Prepare Bulk Update ───────────────────────────────────────────────
    {
      name: 'catalog.prepare_bulk_update',
      description: 'Prepare a bulk product update. Returns a plan with affected count and sample diffs.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = PrepareBulkUpdateSchema.parse(params);

        // Enforce allowed fields
        guardrails.enforceAllowedFields(
          Object.keys(validated.updates),
          config.allowedCatalogUpdateFields,
          'Catalog bulk update',
        );

        const client = context.getClient();

        // Resolve matching products
        const products = await resolveMatchingProducts(client, validated.match, validated.scope?.store_view_code);
        guardrails.enforceBulkSkuCap(products.length);

        // Build sample diffs (show first 5)
        const sampleDiffs = products.slice(0, 5).map((p: Record<string, unknown>) => {
          const diff: Record<string, { from: unknown; to: unknown }> = {};
          for (const [field, newValue] of Object.entries(validated.updates)) {
            diff[field] = { from: p[field], to: newValue };
          }
          return { sku: p['sku'], changes: diff };
        });

        const warnings: string[] = [];
        if (products.length > 100) {
          warnings.push(`Large bulk update: ${products.length} products will be affected.`);
        }

        const plan = planStore.create(
          'catalog.commit_bulk_update',
          {
            skus: products.map((p: Record<string, unknown>) => p['sku']),
            updates: validated.updates,
            scope: validated.scope,
          },
          products.length,
          config.planExpiryMinutes,
          sampleDiffs,
          warnings,
        );

        return {
          plan_id: plan.plan_id,
          expires_at: plan.expires_at,
          affected_count: products.length,
          sample_diffs: sampleDiffs,
          warnings,
          message: 'Plan created. Review and call catalog.commit_bulk_update to execute.',
        };
      },
    },

    // ── Commit Bulk Update ────────────────────────────────────────────────
    {
      name: 'catalog.commit_bulk_update',
      description: 'Execute a previously prepared bulk product update.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = CommitBulkUpdateSchema.parse(params);
        guardrails.requireConfirmation(RiskTier.Risk, params);

        // Check idempotency
        if (validated.idempotency_key) {
          const existing = idempotencyLedger.get(validated.idempotency_key);
          if (existing) {
            return {
              message: 'Operation already completed (idempotency match)',
              previous_result: existing.result_summary,
            };
          }
        }

        const plan = planStore.consume(validated.plan_id);
        if (!plan) {
          throw new Error('Plan not found or expired. Prepare a new plan.');
        }

        const payload = plan.payload as { skus: string[]; updates: Record<string, unknown>; scope: Record<string, string> };
        const client = context.getClient();
        const storeCode = payload.scope?.store_view_code;

        let successCount = 0;
        const errors: Array<{ sku: string; error: string }> = [];

        for (const sku of payload.skus) {
          try {
            await client.put(`/V1/products/${encodeURIComponent(sku)}`, {
              product: { sku, ...payload.updates },
            }, storeCode);
            successCount++;
          } catch (err) {
            errors.push({ sku, error: err instanceof Error ? err.message : String(err) });
          }
        }

        const summary = `Updated ${successCount}/${payload.skus.length} products. ${errors.length} errors.`;

        if (validated.idempotency_key) {
          idempotencyLedger.record(validated.idempotency_key, 'catalog.commit_bulk_update', summary);
        }

        return {
          message: summary,
          success_count: successCount,
          error_count: errors.length,
          errors: errors.length > 0 ? errors : undefined,
        };
      },
    },
  ];
}

/**
 * Resolve products matching the given criteria.
 */
async function resolveMatchingProducts(
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

  if (match.attribute_filters) {
    for (const [field, spec] of Object.entries(match.attribute_filters)) {
      if (typeof spec === 'object' && spec !== null) {
        const s = spec as Record<string, string>;
        filterGroups.push({
          filters: [{ field, value: s['value'] || '', conditionType: s['condition'] || 'eq' }],
        });
      } else {
        filterGroups.push({
          filters: [{ field, value: String(spec), conditionType: 'eq' }],
        });
      }
    }
  }

  if (match.category_id) {
    filterGroups.push({
      filters: [{ field: 'category_id', value: String(match.category_id), conditionType: 'eq' }],
    });
  }

  const searchParams = client.buildSearchParams({
    filterGroups: filterGroups.length > 0 ? filterGroups : undefined,
    pageSize: 2000, // Max page to resolve all matches
  });

  const result = await client.get<{ items: Array<Record<string, unknown>> }>('/V1/products', searchParams, storeCode);
  return result.items || [];
}
