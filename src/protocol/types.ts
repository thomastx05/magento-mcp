/**
 * Protocol types for the Magento MCP stdio JSON-RPC-like server.
 */

// ── Risk Tiers ──────────────────────────────────────────────────────────────

export enum RiskTier {
  Safe = 1,     // read ops, small edits
  Risk = 2,     // bulk changes, promotion enabling, targeted CDN purge
  Critical = 3, // broad cache flush, reindex-all (excluded v1)
}

// ── Request / Response Envelopes ────────────────────────────────────────────

export interface McpRequest {
  id: string;
  action: string;
  params: Record<string, unknown>;
}

export interface McpSuccessResponse {
  id: string;
  status: 'success';
  result: unknown;
}

export interface McpErrorResponse {
  id: string;
  status: 'error';
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type McpResponse = McpSuccessResponse | McpErrorResponse;

// ── Error Codes ─────────────────────────────────────────────────────────────

export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  MAGENTO_API_ERROR: 'MAGENTO_API_ERROR',
  PLAN_NOT_FOUND: 'PLAN_NOT_FOUND',
  PLAN_EXPIRED: 'PLAN_EXPIRED',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  BULK_CAP_EXCEEDED: 'BULK_CAP_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  ACTION_NOT_FOUND: 'ACTION_NOT_FOUND',
  FASTLY_API_ERROR: 'FASTLY_API_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// ── Action Definition ───────────────────────────────────────────────────────

export interface ActionDefinition {
  name: string;
  description: string;
  riskTier: RiskTier;
  requiresAuth: boolean;
  inputSchema?: Record<string, unknown>;
  handler: (params: Record<string, unknown>, context: ActionContext) => Promise<unknown>;
}

// ── Action Context (passed to every handler) ────────────────────────────────

export interface ActionContext {
  sessionId: string;
  getToken: () => string | null;
  getBaseUrl: () => string | null;
  getDefaultScope: () => StoreScope | null;
  getOAuthCredentials: () => import('../client/magentoRest').OAuthCredentials | null;
  getClient: () => import('../client/magentoRest').MagentoRestClient;
  username: string | null;
}

// ── Store / Scope ───────────────────────────────────────────────────────────

export interface StoreScope {
  website_code?: string;
  store_code?: string;
  store_view_code?: string;
  scope?: 'global';
}

// ── Audit Record ────────────────────────────────────────────────────────────

export interface AuditRecord {
  timestamp: string;
  username: string | null;
  action: string;
  scope: StoreScope | null;
  params: Record<string, unknown>;
  result_summary: string;
  plan_id: string | null;
  reason: string | null;
}

// ── Plan (for two-phase commit) ─────────────────────────────────────────────

export interface BulkPlan {
  plan_id: string;
  action: string;
  created_at: string;
  expires_at: string;
  payload: unknown;
  affected_count: number;
  sample_diffs?: unknown[];
  warnings?: string[];
}

// ── Idempotency ─────────────────────────────────────────────────────────────

export interface IdempotencyEntry {
  key: string;
  action: string;
  created_at: string;
  result_summary: string;
}
