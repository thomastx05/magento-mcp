/**
 * Pricing actions: Bulk price updates (two-phase commit).
 */

import { ActionDefinition, ActionContext, RiskTier } from '../protocol/types';
import {
  PrepareBulkPriceUpdateSchema,
  CommitBulkPriceUpdateSchema,
} from '../validation/schemas';
import { MagentoRestClient } from '../client/magentoRest';
// Note: MagentoRestClient import kept for resolvePricingProducts helper
import { PlanStore } from '../session/planStore';
import { Guardrails } from '../validation/guardrails';
import { IdempotencyLedger } from '../session/idempotencyLedger';
import { McpConfig } from '../config';

export function createPricingActions(
  planStore: PlanStore,
  guardrails: Guardrails,
  idempotencyLedger: IdempotencyLedger,
  config: McpConfig,
): ActionDefinition[] {
  return [
    // ── Prepare Bulk Price Update ─────────────────────────────────────────
    {
      name: 'pricing.prepare_bulk_price_update',
      description: 'Prepare a bulk price update. Returns plan with affected count, diffs, and warnings.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = PrepareBulkPriceUpdateSchema.parse(params);
        const client = context.getClient();

        // Resolve matching products
        const products = await resolvePricingProducts(client, validated.match, validated.scope?.store_view_code);
        guardrails.enforceBulkSkuCap(products.length);

        // Build sample diffs and check price thresholds
        const warnings: string[] = [];
        const sampleDiffs = products.slice(0, 5).map((p: Record<string, unknown>) => {
          const diff: Record<string, { from: unknown; to: unknown }> = {};

          if (validated.price_updates.price !== undefined) {
            diff['price'] = { from: p['price'], to: validated.price_updates.price };
            const warning = guardrails.checkPriceChangeThreshold(
              Number(p['price']) || 0,
              validated.price_updates.price,
            );
            if (warning) warnings.push(`SKU ${p['sku']}: ${warning}`);
          }

          if (validated.price_updates.special_price !== undefined) {
            diff['special_price'] = { from: p['special_price'], to: validated.price_updates.special_price };
          }

          return { sku: p['sku'], changes: diff };
        });

        if (products.length > 100) {
          warnings.push(`Large bulk price update: ${products.length} products will be affected.`);
        }

        const plan = planStore.create(
          'pricing.commit_bulk_price_update',
          {
            skus: products.map((p: Record<string, unknown>) => p['sku']),
            price_updates: validated.price_updates,
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
          message: 'Price update plan created. Review and call pricing.commit_bulk_price_update to execute.',
        };
      },
    },

    // ── Commit Bulk Price Update ──────────────────────────────────────────
    {
      name: 'pricing.commit_bulk_price_update',
      description: 'Execute a previously prepared bulk price update.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = CommitBulkPriceUpdateSchema.parse(params);
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

        const payload = plan.payload as {
          skus: string[];
          price_updates: Record<string, unknown>;
          scope: Record<string, string>;
        };

        const client = context.getClient();
        const storeCode = payload.scope?.store_view_code;

        let successCount = 0;
        const errors: Array<{ sku: string; error: string }> = [];

        for (const sku of payload.skus) {
          try {
            await client.put(`/V1/products/${encodeURIComponent(sku)}`, {
              product: { sku, ...payload.price_updates },
            }, storeCode);
            successCount++;
          } catch (err) {
            errors.push({ sku, error: err instanceof Error ? err.message : String(err) });
          }
        }

        const summary = `Updated prices for ${successCount}/${payload.skus.length} products. ${errors.length} errors.`;

        if (validated.idempotency_key) {
          idempotencyLedger.record(validated.idempotency_key, 'pricing.commit_bulk_price_update', summary);
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

async function resolvePricingProducts(
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

  const searchParams = client.buildSearchParams({
    filterGroups: filterGroups.length > 0 ? filterGroups : undefined,
    pageSize: 2000,
  });

  const result = await client.get<{ items: Array<Record<string, unknown>> }>('/V1/products', searchParams, storeCode);
  return result.items || [];
}
