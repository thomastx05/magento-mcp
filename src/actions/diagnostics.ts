/**
 * Diagnostics actions: Product display checks, indexer status, inventory reports.
 * All read-only (Tier 1).
 */

import { ActionDefinition, ActionContext, RiskTier } from '../protocol/types';
import {
  DiagnosticsProductDisplaySchema,
  DiagnosticsInventorySchema,
} from '../validation/schemas';

export function createDiagnosticsActions(): ActionDefinition[] {
  return [
    // ── Product Display Check ─────────────────────────────────────────────
    {
      name: 'diagnostics.product_display_check',
      description: 'Check why a product may not be displaying correctly on the storefront.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = DiagnosticsProductDisplaySchema.parse(params);
        const client = context.getClient();
        const storeCode = validated.store_view_code;

        // Fetch product data
        let product: Record<string, unknown>;
        try {
          product = await client.get<Record<string, unknown>>(
            `/V1/products/${encodeURIComponent(validated.sku)}`,
            undefined,
            storeCode,
          );
        } catch (err) {
          return {
            sku: validated.sku,
            found: false,
            issues: [`Product not found: ${err instanceof Error ? err.message : String(err)}`],
            recommended_actions: [],
          };
        }

        const issues: string[] = [];
        const recommendedActions: string[] = [];

        // Check status
        const status = product['status'];
        if (status === 2 || status === '2') {
          issues.push('Product is DISABLED (status=2).');
          recommendedActions.push('catalog.prepare_bulk_update to set status=1 (enabled)');
        }

        // Check visibility
        const visibility = product['visibility'];
        if (visibility === 1 || visibility === '1') {
          issues.push('Product visibility is "Not Visible Individually" (visibility=1). It will only appear as part of a grouped/configurable product.');
          recommendedActions.push('catalog.prepare_bulk_update to set visibility=4 (catalog+search)');
        }

        // Check price
        const price = Number(product['price']);
        if (!price || price <= 0) {
          issues.push('Product has no price or price is 0.');
          recommendedActions.push('pricing.prepare_bulk_price_update to set a valid price');
        }

        // Check website assignment
        const extensionAttributes = product['extension_attributes'] as Record<string, unknown> | undefined;
        const websiteIds = extensionAttributes?.['website_ids'] as number[] | undefined;
        if (!websiteIds || websiteIds.length === 0) {
          issues.push('Product is not assigned to any website.');
          recommendedActions.push('Assign product to appropriate website(s) via Magento Admin');
        }

        // Check category assignment
        const customAttributes = product['custom_attributes'] as Array<{ attribute_code: string; value: unknown }> | undefined;
        const categoryIds = customAttributes?.find((a) => a.attribute_code === 'category_ids');
        if (!categoryIds || !Array.isArray(categoryIds.value) || (categoryIds.value as unknown[]).length === 0) {
          issues.push('Product is not assigned to any category.');
          recommendedActions.push('catalog.prepare_bulk_update to assign categories');
        }

        // Check images
        const mediaGallery = product['media_gallery_entries'] as unknown[] | undefined;
        if (!mediaGallery || mediaGallery.length === 0) {
          issues.push('Product has no images.');
        }

        // Check stock / MSI
        try {
          const stockItem = extensionAttributes?.['stock_item'] as Record<string, unknown> | undefined;
          if (stockItem) {
            const isInStock = stockItem['is_in_stock'];
            const qty = Number(stockItem['qty']);
            if (!isInStock) {
              issues.push('Product is marked as OUT OF STOCK.');
              recommendedActions.push('Update stock status in Magento Admin or via inventory API');
            }
            if (qty <= 0) {
              issues.push(`Product quantity is ${qty}.`);
            }
          }
        } catch {
          // Stock info may not be available
        }

        // Try MSI salable quantity
        try {
          const salableQty = await client.get<Array<{ stock_id: number; qty: number }>>(
            `/V1/inventory/get-product-salable-quantity/${encodeURIComponent(validated.sku)}/1`,
          );
          if (Array.isArray(salableQty) && salableQty.length > 0) {
            const totalSalable = salableQty.reduce((sum, s) => sum + s.qty, 0);
            if (totalSalable <= 0) {
              issues.push(`MSI salable quantity is ${totalSalable}.`);
            }
          }
        } catch {
          // MSI may not be available
        }

        return {
          sku: validated.sku,
          found: true,
          product_name: product['name'],
          status: product['status'],
          visibility: product['visibility'],
          price: product['price'],
          issues: issues.length > 0 ? issues : ['No issues detected.'],
          recommended_actions: recommendedActions,
        };
      },
    },

    // ── Indexer Status Report ─────────────────────────────────────────────
    {
      name: 'diagnostics.indexer_status_report',
      description: 'Report on the status of all Magento indexers.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (_params: Record<string, unknown>, context: ActionContext) => {
        const client = context.getClient();

        try {
          const indexers = await client.get<Array<Record<string, unknown>>>('/V1/indexer/status');

          const needsReindex = indexers.filter((i) => i['status'] !== 'valid');

          return {
            indexers,
            total: indexers.length,
            valid: indexers.filter((i) => i['status'] === 'valid').length,
            invalid: needsReindex.length,
            needs_reindex: needsReindex.map((i) => ({
              indexer_id: i['indexer_id'],
              title: i['title'],
              status: i['status'],
            })),
          };
        } catch {
          // Fallback: endpoint may not be available
          return {
            message: 'Indexer status endpoint not available. Check Magento version and modules.',
            indexers: [],
          };
        }
      },
    },

    // ── Inventory Salable Report ──────────────────────────────────────────
    {
      name: 'diagnostics.inventory_salable_report',
      description: 'Report on MSI salable quantity for a product.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = DiagnosticsInventorySchema.parse(params);
        const client = context.getClient();

        try {
          // Get product stock info
          const product = await client.get<Record<string, unknown>>(
            `/V1/products/${encodeURIComponent(validated.sku)}`,
          );

          const extensionAttributes = product['extension_attributes'] as Record<string, unknown> | undefined;
          const stockItem = extensionAttributes?.['stock_item'] as Record<string, unknown> | undefined;

          // Try MSI endpoints
          let salableInfo: unknown = null;
          try {
            salableInfo = await client.get(
              `/V1/inventory/get-product-salable-quantity/${encodeURIComponent(validated.sku)}/1`,
            );
          } catch {
            // MSI not available
          }

          let sourceItems: unknown = null;
          try {
            const searchParams = client.buildSearchParams({
              filterGroups: [
                { filters: [{ field: 'sku', value: validated.sku, conditionType: 'eq' }] },
              ],
            });
            sourceItems = await client.get('/V1/inventory/source-items', searchParams);
          } catch {
            // Source items endpoint not available
          }

          return {
            sku: validated.sku,
            stock_item: stockItem || null,
            salable_quantity: salableInfo,
            source_items: sourceItems,
          };
        } catch (err) {
          return {
            sku: validated.sku,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
  ];
}
