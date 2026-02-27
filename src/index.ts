/**
 * Magento MCP — Main entry point.
 *
 * Wires up all components:
 * - Configuration
 * - Session store
 * - Plan store
 * - Idempotency ledger
 * - Audit logger
 * - Guardrails
 * - All action handlers
 * - MCP SDK server over stdio
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadConfig } from './config';
import { SessionStore } from './session/sessionStore';
import { PlanStore } from './session/planStore';
import { IdempotencyLedger } from './session/idempotencyLedger';
import { AuditLogger } from './audit/auditLogger';
import { Guardrails } from './validation/guardrails';
import { ActionDefinition, ActionContext, RiskTier, AuditRecord } from './protocol/types';
import { MagentoRestClient } from './client/magentoRest';

// Actions
import { createAuthActions } from './actions/auth';
import { createScopeActions } from './actions/scope';
import { createPromotionsActions } from './actions/promotions';
import { createCatalogActions } from './actions/catalog';
import { createPricingActions } from './actions/pricing';
import { createCmsActions } from './actions/cms';
import { createSeoActions } from './actions/seo';
import { createDiagnosticsActions } from './actions/diagnostics';
import { createCacheActions } from './actions/cache';

async function main(): Promise<void> {
  // Load configuration
  const config = loadConfig();

  // Initialize stores
  const sessionStore = new SessionStore();
  const planStore = new PlanStore();
  const idempotencyLedger = new IdempotencyLedger(config.idempotencyLedgerPath);
  const auditLogger = new AuditLogger(config.auditLogPath);
  const guardrails = new Guardrails(config);

  // Collect all actions from existing handlers
  const allActions: ActionDefinition[] = [
    ...createAuthActions(sessionStore),
    ...createScopeActions(sessionStore),
    ...createPromotionsActions(planStore, guardrails, config),
    ...createCatalogActions(planStore, guardrails, idempotencyLedger, config),
    ...createPricingActions(planStore, guardrails, idempotencyLedger, config),
    ...createCmsActions(planStore, guardrails, config),
    ...createSeoActions(planStore, guardrails, config),
    ...createDiagnosticsActions(),
    ...createCacheActions(guardrails, config),
  ];

  // Create the MCP server using the official SDK
  const mcpServer = new McpServer(
    { name: 'magento-mcp', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Adobe Commerce Cloud (Magento 2) MCP server for business-level administration. Call auth_login first with your Magento Admin username and password to establish a session before using other tools.',
    },
  );

  // Session ID for the single-user stdio session
  const sessionId = 'default';

  // Register each action as an MCP tool
  for (const action of allActions) {
    // Convert dots to underscores for MCP tool names (e.g. "auth.login" -> "auth_login")
    const toolName = action.name.replace(/\./g, '_');

    mcpServer.tool(
      toolName,
      action.description,
      { params: z.record(z.unknown()).optional().describe('Action parameters as a JSON object') },
      async (args) => {
        const params = (args.params || {}) as Record<string, unknown>;

        // Check authentication
        if (action.requiresAuth) {
          const token = sessionStore.getToken(sessionId);
          if (!token) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated. Call auth_login first.' } }, null, 2) }],
              isError: true,
            };
          }
        }

        // Build action context
        const context: ActionContext = {
          sessionId,
          getToken: () => sessionStore.getToken(sessionId),
          getBaseUrl: () => sessionStore.getBaseUrl(sessionId),
          getDefaultScope: () => sessionStore.getDefaultScope(sessionId),
          getOAuthCredentials: () => sessionStore.getOAuthCredentials(sessionId),
          getClient: () => {
            const baseUrl = sessionStore.getBaseUrl(sessionId);
            const token = sessionStore.getToken(sessionId);
            if (!baseUrl) throw new Error('No active session');
            const client = new MagentoRestClient(baseUrl, token);
            const oauth = sessionStore.getOAuthCredentials(sessionId);
            if (oauth) client.setOAuth(oauth);
            return client;
          },
          username: sessionStore.getUsername(sessionId),
        };

        try {
          const result = await action.handler(params, context);

          // Audit log
          const auditRecord: AuditRecord = {
            timestamp: new Date().toISOString(),
            username: context.username,
            action: action.name,
            scope: context.getDefaultScope(),
            params,
            result_summary: summarizeResult(result),
            plan_id: (params['plan_id'] as string) || null,
            reason: (params['reason'] as string) || null,
          };
          auditLogger.log(auditRecord);

          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);

          // Audit the error
          const auditRecord: AuditRecord = {
            timestamp: new Date().toISOString(),
            username: context.username,
            action: action.name,
            scope: null,
            params,
            result_summary: `ERROR: ${errorMessage}`,
            plan_id: null,
            reason: null,
          };
          auditLogger.log(auditRecord);

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: errorMessage }, null, 2) }],
            isError: true,
          };
        }
      },
    );
  }

  // Log to stderr (not stdout, to keep protocol clean)
  process.stderr.write(`\nMagento MCP v1.0.0 (MCP SDK)\n`);
  process.stderr.write(`Registered ${allActions.length} tools\n`);
  for (const action of allActions) {
    const tier = action.riskTier === 1 ? 'Safe' : action.riskTier === 2 ? 'Risk' : 'Critical';
    process.stderr.write(`  [Tier ${action.riskTier}/${tier}] ${action.name.replace(/\./g, '_')} — ${action.description}\n`);
  }
  process.stderr.write(`\nEnvironment: ${config.defaultEnvironment}\n`);
  process.stderr.write(`Fastly: ${config.fastlyServiceId ? 'configured' : 'not configured'}\n`);
  process.stderr.write(`Base URL: ${process.env.MAGENTO_BASE_URL || '(not set — provide in auth_login params)'}\n`);
  process.stderr.write(`Audit log: ${config.auditLogPath}\n\n`);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

function summarizeResult(result: unknown): string {
  if (result === null || result === undefined) return 'null';
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (obj['message']) return String(obj['message']);
    if (obj['total_count'] !== undefined) return `total_count: ${obj['total_count']}`;
    return `object with keys: ${Object.keys(obj).join(', ')}`;
  }
  return String(result);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
