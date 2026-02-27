/**
 * Configuration system for Magento MCP guardrails and limits.
 * All values configurable via environment variables or a local config file.
 */

export interface McpConfig {
  /** Max SKUs per bulk commit (default 500) */
  maxSkusPerBulkCommit: number;

  /** Max coupon quantity per generation request (default 1000) */
  maxCouponQtyPerGeneration: number;

  /** Price change threshold percentage that triggers a warning (default 50) */
  priceChangeThresholdPercent: number;

  /** Max discount percentage allowed without override (default 50) */
  maxDiscountPercent: number;

  /** Tier 2 confirmation always required in production (default true) */
  tier2ConfirmationRequired: boolean;

  /** Default environment (default "staging") */
  defaultEnvironment: string;

  /** Plan expiry in minutes (default 30) */
  planExpiryMinutes: number;

  /** Cache purge rate limit per minute (default 10) */
  cachePurgeRateLimitPerMinute: number;

  /** Audit log file path (default "./audit.jsonl") */
  auditLogPath: string;

  /** Idempotency ledger file path (default "./idempotency.json") */
  idempotencyLedgerPath: string;

  /** Allowed update fields for catalog bulk updates */
  allowedCatalogUpdateFields: string[];

  /** Allowed update fields for CMS page updates */
  allowedCmsPageUpdateFields: string[];

  /** Allowed update fields for CMS block updates */
  allowedCmsBlockUpdateFields: string[];

  /** Fastly service ID (optional, from env) */
  fastlyServiceId: string | null;

  /** Fastly API token (optional, from env) */
  fastlyApiToken: string | null;
}

const defaultConfig: McpConfig = {
  maxSkusPerBulkCommit: 500,
  maxCouponQtyPerGeneration: 1000,
  priceChangeThresholdPercent: 50,
  maxDiscountPercent: 50,
  tier2ConfirmationRequired: true,
  defaultEnvironment: 'staging',
  planExpiryMinutes: 30,
  cachePurgeRateLimitPerMinute: 10,
  auditLogPath: './audit.jsonl',
  idempotencyLedgerPath: './idempotency.json',
  allowedCatalogUpdateFields: [
    'name',
    'description',
    'short_description',
    'meta_title',
    'meta_description',
    'meta_keyword',
    'url_key',
    'status',
    'visibility',
    'price',
    'special_price',
    'special_from_date',
    'special_to_date',
    'weight',
    'category_ids',
  ],
  allowedCmsPageUpdateFields: [
    'title',
    'content',
    'content_heading',
    'meta_title',
    'meta_description',
    'meta_keywords',
    'is_active',
  ],
  allowedCmsBlockUpdateFields: [
    'title',
    'content',
    'is_active',
  ],
  fastlyServiceId: null,
  fastlyApiToken: null,
};

function parseIntEnv(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function parseBoolEnv(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val.toLowerCase() === 'true' || val === '1';
}

export function loadConfig(): McpConfig {
  return {
    ...defaultConfig,
    maxSkusPerBulkCommit: parseIntEnv('MCP_MAX_SKUS_PER_BULK', defaultConfig.maxSkusPerBulkCommit),
    maxCouponQtyPerGeneration: parseIntEnv('MCP_MAX_COUPON_QTY', defaultConfig.maxCouponQtyPerGeneration),
    priceChangeThresholdPercent: parseIntEnv('MCP_PRICE_THRESHOLD_PCT', defaultConfig.priceChangeThresholdPercent),
    maxDiscountPercent: parseIntEnv('MCP_MAX_DISCOUNT_PCT', defaultConfig.maxDiscountPercent),
    tier2ConfirmationRequired: parseBoolEnv('MCP_TIER2_CONFIRM', defaultConfig.tier2ConfirmationRequired),
    defaultEnvironment: process.env['MCP_DEFAULT_ENV'] ?? defaultConfig.defaultEnvironment,
    planExpiryMinutes: parseIntEnv('MCP_PLAN_EXPIRY_MIN', defaultConfig.planExpiryMinutes),
    cachePurgeRateLimitPerMinute: parseIntEnv('MCP_CACHE_RATE_LIMIT', defaultConfig.cachePurgeRateLimitPerMinute),
    auditLogPath: process.env['MCP_AUDIT_LOG_PATH'] ?? defaultConfig.auditLogPath,
    idempotencyLedgerPath: process.env['MCP_IDEMPOTENCY_PATH'] ?? defaultConfig.idempotencyLedgerPath,
    fastlyServiceId: process.env['FASTLY_SERVICE_ID'] ?? null,
    fastlyApiToken: process.env['FASTLY_API_TOKEN'] ?? null,
  };
}
