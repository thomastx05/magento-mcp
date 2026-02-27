/**
 * stdio JSON-RPC-like server for Magento MCP.
 * Reads newline-delimited JSON from stdin, dispatches to action handlers,
 * writes JSON responses to stdout.
 */

import * as readline from 'readline';
import {
  McpRequest,
  McpResponse,
  McpErrorResponse,
  ActionDefinition,
  ActionContext,
  ErrorCodes,
  RiskTier,
  AuditRecord,
} from './types';
import { SessionStore } from '../session/sessionStore';
import { AuditLogger } from '../audit/auditLogger';
import { Guardrails } from '../validation/guardrails';
import { ZodError } from 'zod';
import { MagentoApiException } from '../client/magentoRest';
import { GuardrailError } from '../validation/guardrails';

export class StdioServer {
  private actionRegistry = new Map<string, ActionDefinition>();
  private sessionId: string = 'default';

  constructor(
    private sessionStore: SessionStore,
    private auditLogger: AuditLogger,
    private guardrails: Guardrails,
  ) {}

  /**
   * Register an action handler.
   */
  registerAction(action: ActionDefinition): void {
    this.actionRegistry.set(action.name, action);
  }

  /**
   * Register multiple action handlers.
   */
  registerActions(actions: ActionDefinition[]): void {
    for (const action of actions) {
      this.registerAction(action);
    }
  }

  /**
   * Start the server — reads from stdin, writes to stdout.
   */
  start(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let request: McpRequest;
      try {
        request = JSON.parse(trimmed) as McpRequest;
      } catch {
        const errorResponse: McpErrorResponse = {
          id: 'unknown',
          status: 'error',
          error: {
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Invalid JSON input.',
          },
        };
        this.writeResponse(errorResponse);
        return;
      }

      const response = await this.handleRequest(request);
      this.writeResponse(response);
    });

    rl.on('close', () => {
      process.exit(0);
    });

    // Log to stderr that we're ready (never log tokens to stdout)
    process.stderr.write('Magento MCP server started. Awaiting requests on stdin.\n');
  }

  /**
   * Handle a single request and return a response.
   */
  private async handleRequest(request: McpRequest): Promise<McpResponse> {
    const { id, action: actionName, params } = request;

    // Find the action
    const action = this.actionRegistry.get(actionName);
    if (!action) {
      return {
        id,
        status: 'error',
        error: {
          code: ErrorCodes.ACTION_NOT_FOUND,
          message: `Unknown action: ${actionName}`,
          details: {
            available_actions: Array.from(this.actionRegistry.keys()),
          },
        },
      };
    }

    // Check authentication
    if (action.requiresAuth) {
      const token = this.sessionStore.getToken(this.sessionId);
      if (!token) {
        return {
          id,
          status: 'error',
          error: {
            code: ErrorCodes.NOT_AUTHENTICATED,
            message: 'Not authenticated. Call auth.login first.',
          },
        };
      }
    }

    // Check Tier 2+ confirmation if required
    if (action.riskTier >= RiskTier.Risk) {
      try {
        this.guardrails.requireConfirmation(action.riskTier, params);
      } catch (err) {
        if (err instanceof GuardrailError) {
          return {
            id,
            status: 'error',
            error: {
              code: err.code,
              message: err.message,
              details: err.details,
            },
          };
        }
      }
    }

    // Build action context
    const context: ActionContext = {
      sessionId: this.sessionId,
      getToken: () => this.sessionStore.getToken(this.sessionId),
      getBaseUrl: () => this.sessionStore.getBaseUrl(this.sessionId),
      getDefaultScope: () => this.sessionStore.getDefaultScope(this.sessionId),
      getOAuthCredentials: () => this.sessionStore.getOAuthCredentials(this.sessionId),
      getClient: () => { throw new Error('getClient not available in legacy stdio server'); },
      username: this.sessionStore.getUsername(this.sessionId),
    };

    // Execute the handler
    try {
      const result = await action.handler(params, context);

      // Audit log
      const auditRecord: AuditRecord = {
        timestamp: new Date().toISOString(),
        username: context.username,
        action: actionName,
        scope: context.getDefaultScope(),
        params,
        result_summary: this.summarizeResult(result),
        plan_id: (params['plan_id'] as string) || null,
        reason: (params['reason'] as string) || null,
      };
      this.auditLogger.log(auditRecord);

      return {
        id,
        status: 'success',
        result,
      };
    } catch (err) {
      return this.handleError(id, actionName, err);
    }
  }

  private handleError(id: string, actionName: string, err: unknown): McpResponse {
    // Audit the error too
    const auditRecord: AuditRecord = {
      timestamp: new Date().toISOString(),
      username: null,
      action: actionName,
      scope: null,
      params: {},
      result_summary: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      plan_id: null,
      reason: null,
    };
    this.auditLogger.log(auditRecord);

    if (err instanceof ZodError) {
      return {
        id,
        status: 'error',
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Validation error',
          details: err.errors,
        },
      };
    }

    if (err instanceof GuardrailError) {
      return {
        id,
        status: 'error',
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      };
    }

    if (err instanceof MagentoApiException) {
      return {
        id,
        status: 'error',
        error: {
          code: ErrorCodes.MAGENTO_API_ERROR,
          message: err.message,
          details: { statusCode: err.statusCode, parameters: err.parameters },
        },
      };
    }

    return {
      id,
      status: 'error',
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  private writeResponse(response: McpResponse): void {
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  private summarizeResult(result: unknown): string {
    if (result === null || result === undefined) return 'null';
    if (typeof result === 'object') {
      const obj = result as Record<string, unknown>;
      if (obj['message']) return String(obj['message']);
      if (obj['total_count'] !== undefined) return `total_count: ${obj['total_count']}`;
      return `object with keys: ${Object.keys(obj).join(', ')}`;
    }
    return String(result);
  }

  /**
   * Get list of registered actions (for help/discovery).
   */
  getRegisteredActions(): Array<{ name: string; description: string; riskTier: RiskTier; requiresAuth: boolean }> {
    return Array.from(this.actionRegistry.values()).map((a) => ({
      name: a.name,
      description: a.description,
      riskTier: a.riskTier,
      requiresAuth: a.requiresAuth,
    }));
  }
}
