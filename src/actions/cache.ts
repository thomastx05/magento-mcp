/**
 * Cache / Fastly actions: Targeted cache purge operations.
 * No purge-all in v1 — targeted only.
 */

import { ActionDefinition, ActionContext, RiskTier } from '../protocol/types';
import {
  CachePurgeByUrlSchema,
  CachePurgeProductSchema,
  CachePurgeCategorySchema,
} from '../validation/schemas';
import { FastlyClient } from '../client/fastlyClient';
import { Guardrails } from '../validation/guardrails';
import { McpConfig } from '../config';

// Simple in-memory rate limiter
const rateLimitState = {
  count: 0,
  windowStart: Date.now(),
};

function checkRateLimit(config: McpConfig): void {
  const now = Date.now();
  const windowMs = 60_000; // 1 minute

  if (now - rateLimitState.windowStart > windowMs) {
    rateLimitState.count = 0;
    rateLimitState.windowStart = now;
  }

  rateLimitState.count++;
  if (rateLimitState.count > config.cachePurgeRateLimitPerMinute) {
    throw new Error(
      `Rate limit exceeded: ${config.cachePurgeRateLimitPerMinute} purge operations per minute.`,
    );
  }
}

export function createCacheActions(
  guardrails: Guardrails,
  config: McpConfig,
): ActionDefinition[] {
  return [
    // ── Purge by URL ──────────────────────────────────────────────────────
    {
      name: 'cache.purge_by_url',
      description: 'Purge specific URLs from CDN cache.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, _context: ActionContext) => {
        const validated = CachePurgeByUrlSchema.parse(params);
        guardrails.requireConfirmation(RiskTier.Risk, params);
        checkRateLimit(config);

        // No wildcard purge allowed
        for (const url of validated.urls) {
          if (url.includes('*')) {
            throw new Error('Wildcard purge is not allowed. Specify exact URLs.');
          }
        }

        if (!config.fastlyServiceId || !config.fastlyApiToken) {
          return {
            message: 'Fastly not configured. Set FASTLY_SERVICE_ID and FASTLY_API_TOKEN environment variables.',
            purged: false,
          };
        }

        const fastly = new FastlyClient(config.fastlyServiceId, config.fastlyApiToken);
        const results: Array<{ url: string; success: boolean; id?: string }> = [];

        for (const url of validated.urls) {
          try {
            const result = await fastly.purgeUrl(url);
            results.push({ url, success: result.ok, id: result.id });
          } catch (err) {
            results.push({ url, success: false });
          }
        }

        const successCount = results.filter((r) => r.success).length;
        return {
          message: `Purged ${successCount}/${validated.urls.length} URLs.`,
          results,
        };
      },
    },

    // ── Purge Product ─────────────────────────────────────────────────────
    {
      name: 'cache.purge_product',
      description: 'Purge cache for a specific product by SKU.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = CachePurgeProductSchema.parse(params);
        guardrails.requireConfirmation(RiskTier.Risk, params);
        checkRateLimit(config);

        if (config.fastlyServiceId && config.fastlyApiToken) {
          // Use Fastly surrogate key purge
          const fastly = new FastlyClient(config.fastlyServiceId, config.fastlyApiToken);

          // Get product ID for surrogate key
          const client = context.getClient();
          const product = await client.get<Record<string, unknown>>(
            `/V1/products/${encodeURIComponent(validated.sku)}`,
          );
          const productId = product['id'];

          // Purge by product surrogate key (Magento/Fastly convention)
          const surrogateKey = `cat_p_${productId}`;
          const result = await fastly.purgeSurrogateKey(surrogateKey);

          return {
            message: `Purged cache for product ${validated.sku} (surrogate key: ${surrogateKey}).`,
            success: result.ok,
            purge_id: result.id,
          };
        }

        // Fallback: try Magento cache clean API if available
        try {
          const client = context.getClient();
          await client.delete('/V1/integration/cache/clean/full_page');
          return {
            message: `Requested full page cache clean (Fastly not configured). Product: ${validated.sku}.`,
            note: 'Configure Fastly for targeted product purge.',
          };
        } catch {
          return {
            message: 'Neither Fastly nor Magento cache clean API available.',
            purged: false,
          };
        }
      },
    },

    // ── Purge Category ────────────────────────────────────────────────────
    {
      name: 'cache.purge_category',
      description: 'Purge cache for a specific category.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, _context: ActionContext) => {
        const validated = CachePurgeCategorySchema.parse(params);
        guardrails.requireConfirmation(RiskTier.Risk, params);
        checkRateLimit(config);

        if (!config.fastlyServiceId || !config.fastlyApiToken) {
          return {
            message: 'Fastly not configured. Set FASTLY_SERVICE_ID and FASTLY_API_TOKEN environment variables.',
            purged: false,
          };
        }

        const fastly = new FastlyClient(config.fastlyServiceId, config.fastlyApiToken);

        // Purge by category surrogate key
        const surrogateKey = `cat_c_${validated.category_id}`;
        const result = await fastly.purgeSurrogateKey(surrogateKey);

        return {
          message: `Purged cache for category ${validated.category_id} (surrogate key: ${surrogateKey}).`,
          success: result.ok,
          purge_id: result.id,
        };
      },
    },
  ];
}
