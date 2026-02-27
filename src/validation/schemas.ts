/**
 * Zod schemas for validating action parameters.
 */

import { z } from 'zod';

// ── Common Schemas ──────────────────────────────────────────────────────────

export const StoreScopeSchema = z.object({
  website_code: z.string().optional(),
  store_code: z.string().optional(),
  store_view_code: z.string().optional(),
  scope: z.literal('global').optional(),
}).refine(
  (data) => data.website_code || data.store_code || data.store_view_code || data.scope,
  { message: 'At least one scope field must be specified for write operations' },
);

export const ConfirmationSchema = z.object({
  confirm: z.literal(true),
  reason: z.string().min(1, 'Reason is required for Tier 2+ operations'),
});

export const IdempotencySchema = z.object({
  idempotency_key: z.string().optional(),
});

export const PaginationSchema = z.object({
  page_size: z.number().int().min(1).max(200).optional().default(20),
  current_page: z.number().int().min(1).optional().default(1),
});

// ── Auth Schemas ────────────────────────────────────────────────────────────

export const AuthLoginSchema = z.object({
  base_url: z.string().url('base_url must be a valid URL').optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
});

// ── Scope Schemas ───────────────────────────────────────────────────────────

export const ScopeSetDefaultSchema = z.object({
  store_view_code: z.string().min(1),
});

// ── Promotions Schemas ──────────────────────────────────────────────────────

export const PrepareCartPriceRuleCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  website_ids: z.array(z.number().int()).min(1),
  customer_group_ids: z.array(z.number().int()).min(1),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  is_active: z.boolean().optional().default(false),
  simple_action: z.enum([
    'by_percent',
    'by_fixed',
    'cart_fixed',
    'buy_x_get_y',
  ]),
  discount_amount: z.number().min(0),
  discount_qty: z.number().min(0).optional(),
  apply_to_shipping: z.boolean().optional().default(false),
  stop_rules_processing: z.boolean().optional().default(false),
  sort_order: z.number().int().optional().default(0),
  coupon_type: z.enum(['no_coupon', 'specific_coupon', 'auto']).optional().default('no_coupon'),
  uses_per_customer: z.number().int().min(0).optional(),
  uses_per_coupon: z.number().int().min(0).optional(),
  conditions: z.unknown().optional(),
  action_conditions: z.unknown().optional(),
});

export const CommitPlanSchema = z.object({
  plan_id: z.string().uuid(),
  confirm: z.literal(true),
  reason: z.string().min(1),
  idempotency_key: z.string().optional(),
});

export const SearchRulesSchema = z.object({
  query: z.string().optional(),
  website_code: z.string().optional(),
  enabled: z.boolean().optional(),
  ...PaginationSchema.shape,
});

export const GetRuleSchema = z.object({
  rule_id: z.number().int(),
});

export const UpdateRuleSchema = z.object({
  rule_id: z.number().int(),
  patch: z.record(z.unknown()),
  confirm: z.literal(true),
  reason: z.string().min(1),
});

export const EnableRuleSchema = z.object({
  rule_id: z.number().int(),
  confirm: z.literal(true),
  reason: z.string().min(1),
});

export const DisableRuleSchema = z.object({
  rule_id: z.number().int(),
});

export const GenerateCouponsSchema = z.object({
  rule_id: z.number().int(),
  qty: z.number().int().min(1),
  prefix: z.string().optional(),
  length: z.number().int().min(4).max(32).optional().default(12),
  format: z.enum(['alphanumeric', 'alphabetical', 'numeric']).optional().default('alphanumeric'),
  uses_per_coupon: z.number().int().min(0).optional(),
});

export const ExportCouponsSchema = z.object({
  rule_id: z.number().int(),
  format: z.literal('csv').optional().default('csv'),
});

// ── Catalog Schemas ─────────────────────────────────────────────────────────

export const CatalogSearchSchema = z.object({
  filters: z.record(z.unknown()).optional(),
  fields: z.array(z.string()).optional(),
  scope: StoreScopeSchema.optional(),
  ...PaginationSchema.shape,
});

export const CatalogGetProductSchema = z.object({
  sku: z.string().min(1),
  scope: StoreScopeSchema.optional(),
});

export const CatalogBulkMatchSchema = z.object({
  sku_list: z.array(z.string()).optional(),
  sku_prefix: z.string().optional(),
  attribute_filters: z.record(z.unknown()).optional(),
  category_id: z.number().int().optional(),
});

export const PrepareBulkUpdateSchema = z.object({
  match: CatalogBulkMatchSchema,
  updates: z.record(z.unknown()),
  scope: StoreScopeSchema,
});

export const CommitBulkUpdateSchema = CommitPlanSchema;

// ── Pricing Schemas ─────────────────────────────────────────────────────────

export const PrepareBulkPriceUpdateSchema = z.object({
  match: CatalogBulkMatchSchema,
  price_updates: z.object({
    price: z.number().optional(),
    special_price: z.number().optional(),
    special_from_date: z.string().optional(),
    special_to_date: z.string().optional(),
  }),
  scope: StoreScopeSchema,
});

export const CommitBulkPriceUpdateSchema = CommitPlanSchema;

// ── CMS Schemas ─────────────────────────────────────────────────────────────

export const CmsSearchPagesSchema = z.object({
  query: z.string().optional(),
  ...PaginationSchema.shape,
});

export const CmsGetPageSchema = z.object({
  page_id: z.number().int(),
});

export const CmsPrepareBulkUpdatePagesSchema = z.object({
  match: z.object({
    page_ids: z.array(z.number().int()).optional(),
    identifier: z.string().optional(),
  }),
  updates: z.record(z.unknown()),
  scope: StoreScopeSchema,
});

export const CmsCommitBulkUpdatePagesSchema = CommitPlanSchema;

export const CmsSearchBlocksSchema = z.object({
  query: z.string().optional(),
  ...PaginationSchema.shape,
});

export const CmsGetBlockSchema = z.object({
  block_id: z.number().int(),
});

export const CmsPrepareBulkUpdateBlocksSchema = z.object({
  match: z.object({
    block_ids: z.array(z.number().int()).optional(),
    identifier: z.string().optional(),
  }),
  updates: z.record(z.unknown()),
  scope: StoreScopeSchema,
});

export const CmsCommitBulkUpdateBlocksSchema = CommitPlanSchema;

// ── SEO Schemas ─────────────────────────────────────────────────────────────

export const SeoPrepareBulkUrlKeysSchema = z.object({
  match: CatalogBulkMatchSchema,
  url_key_transform: z.object({
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    replace: z.object({
      search: z.string(),
      replacement: z.string(),
    }).optional(),
  }),
  scope: StoreScopeSchema,
});

export const SeoCommitBulkUrlKeysSchema = CommitPlanSchema;

export const SeoBulkUpdateMetaSchema = z.object({
  match: CatalogBulkMatchSchema,
  meta_updates: z.object({
    meta_title: z.string().optional(),
    meta_description: z.string().optional(),
    meta_keyword: z.string().optional(),
  }),
  scope: StoreScopeSchema,
  confirm: z.literal(true),
  reason: z.string().min(1),
});

export const SeoRedirectChainsSchema = z.object({
  max_depth: z.number().int().min(1).max(10).optional().default(5),
});

// ── Diagnostics Schemas ─────────────────────────────────────────────────────

export const DiagnosticsProductDisplaySchema = z.object({
  sku: z.string().min(1),
  store_view_code: z.string().optional(),
});

export const DiagnosticsInventorySchema = z.object({
  sku: z.string().min(1),
  website_code: z.string().optional(),
});

// ── Cache Schemas ───────────────────────────────────────────────────────────

export const CachePurgeByUrlSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(50),
  confirm: z.literal(true),
  reason: z.string().min(1),
});

export const CachePurgeProductSchema = z.object({
  sku: z.string().min(1),
  store_view_code: z.string().optional(),
  confirm: z.literal(true),
  reason: z.string().min(1),
});

export const CachePurgeCategorySchema = z.object({
  category_id: z.number().int(),
  store_view_code: z.string().optional(),
  confirm: z.literal(true),
  reason: z.string().min(1),
});
