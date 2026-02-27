/**
 * Promotions actions: Cart price rules and coupon management.
 */

import { ActionDefinition, ActionContext, RiskTier } from '../protocol/types';
import {
  PrepareCartPriceRuleCreateSchema,
  CommitPlanSchema,
  SearchRulesSchema,
  GetRuleSchema,
  UpdateRuleSchema,
  EnableRuleSchema,
  DisableRuleSchema,
  GenerateCouponsSchema,
  ExportCouponsSchema,
} from '../validation/schemas';
import { PlanStore } from '../session/planStore';
import { Guardrails } from '../validation/guardrails';
import { McpConfig } from '../config';

export function createPromotionsActions(
  planStore: PlanStore,
  guardrails: Guardrails,
  config: McpConfig,
): ActionDefinition[] {
  return [
    // ── Prepare Cart Price Rule Create ────────────────────────────────────
    {
      name: 'promotions.prepare_cart_price_rule_create',
      description: 'Validate and prepare a cart price rule for creation. Returns a plan for review.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, _context: ActionContext) => {
        const validated = PrepareCartPriceRuleCreateSchema.parse(params);

        // Enforce guardrails
        guardrails.enforceDiscountLimit(validated.simple_action, validated.discount_amount);

        // Ensure is_active defaults to false (production-safe)
        const rulePayload = {
          ...validated,
          is_active: validated.is_active ?? false,
        };

        // Validate date ordering
        if (rulePayload.from_date && rulePayload.to_date) {
          if (new Date(rulePayload.to_date) <= new Date(rulePayload.from_date)) {
            throw new Error('to_date must be after from_date');
          }
        }

        const warnings: string[] = [];
        if (rulePayload.is_active) {
          warnings.push('Rule will be created in ACTIVE state. Consider creating disabled first.');
        }
        if (!rulePayload.to_date) {
          warnings.push('No end date specified. Rule will run indefinitely if enabled.');
        }

        const plan = planStore.create(
          'promotions.commit_cart_price_rule_create',
          rulePayload,
          1,
          config.planExpiryMinutes,
          [rulePayload],
          warnings,
        );

        return {
          plan_id: plan.plan_id,
          expires_at: plan.expires_at,
          rule_preview: rulePayload,
          warnings,
          message: 'Plan created. Review and call promotions.commit_cart_price_rule_create to execute.',
        };
      },
    },

    // ── Commit Cart Price Rule Create ─────────────────────────────────────
    {
      name: 'promotions.commit_cart_price_rule_create',
      description: 'Execute a previously prepared cart price rule creation.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = CommitPlanSchema.parse(params);
        guardrails.requireConfirmation(RiskTier.Risk, params);

        const plan = planStore.consume(validated.plan_id);
        if (!plan) {
          throw new Error('Plan not found or expired. Prepare a new plan.');
        }

        const client = context.getClient();
        const rulePayload = plan.payload as Record<string, unknown>;

        // Map to Magento API format
        const magentoRule = {
          rule: {
            name: rulePayload.name,
            description: rulePayload.description || '',
            is_active: rulePayload.is_active,
            website_ids: rulePayload.website_ids,
            customer_group_ids: rulePayload.customer_group_ids,
            from_date: rulePayload.from_date || null,
            to_date: rulePayload.to_date || null,
            simple_action: rulePayload.simple_action,
            discount_amount: rulePayload.discount_amount,
            discount_qty: rulePayload.discount_qty ?? 0,
            apply_to_shipping: rulePayload.apply_to_shipping ?? false,
            stop_rules_processing: rulePayload.stop_rules_processing ?? false,
            sort_order: rulePayload.sort_order ?? 0,
            coupon_type: rulePayload.coupon_type === 'specific_coupon' ? 2
              : rulePayload.coupon_type === 'auto' ? 3 : 1,
            uses_per_customer: rulePayload.uses_per_customer ?? 0,
            uses_per_coupon: rulePayload.uses_per_coupon ?? 0,
          },
        };

        const result = await client.post('/V1/salesRules', magentoRule);
        return {
          message: 'Cart price rule created successfully',
          rule: result,
        };
      },
    },

    // ── Search Rules ──────────────────────────────────────────────────────
    {
      name: 'promotions.search_rules',
      description: 'Search cart price rules by query, website, or enabled status.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = SearchRulesSchema.parse(params);
        const client = context.getClient();

        const filterGroups: Array<{ filters: Array<{ field: string; value: string; conditionType?: string }> }> = [];

        if (validated.query) {
          filterGroups.push({
            filters: [{ field: 'name', value: `%${validated.query}%`, conditionType: 'like' }],
          });
        }
        if (validated.enabled !== undefined) {
          filterGroups.push({
            filters: [{ field: 'is_active', value: validated.enabled ? '1' : '0', conditionType: 'eq' }],
          });
        }

        const searchParams = client.buildSearchParams({
          filterGroups: filterGroups.length > 0 ? filterGroups : undefined,
          pageSize: validated.page_size,
          currentPage: validated.current_page,
        });

        const result = await client.get('/V1/salesRules/search', searchParams);
        return result;
      },
    },

    // ── Get Rule ──────────────────────────────────────────────────────────
    {
      name: 'promotions.get_rule',
      description: 'Get details of a specific cart price rule.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = GetRuleSchema.parse(params);
        const client = context.getClient();
        const result = await client.get(`/V1/salesRules/${validated.rule_id}`);
        return result;
      },
    },

    // ── Update Rule ───────────────────────────────────────────────────────
    {
      name: 'promotions.update_rule',
      description: 'Update an existing cart price rule.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = UpdateRuleSchema.parse(params);
        guardrails.requireConfirmation(RiskTier.Risk, params);

        const client = context.getClient();
        const result = await client.put(`/V1/salesRules/${validated.rule_id}`, {
          rule: { rule_id: validated.rule_id, ...validated.patch },
        });
        return { message: 'Rule updated successfully', rule: result };
      },
    },

    // ── Enable Rule ───────────────────────────────────────────────────────
    {
      name: 'promotions.enable_rule',
      description: 'Enable a cart price rule.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = EnableRuleSchema.parse(params);
        guardrails.requireConfirmation(RiskTier.Risk, params);

        const client = context.getClient();
        const result = await client.put(`/V1/salesRules/${validated.rule_id}`, {
          rule: { rule_id: validated.rule_id, is_active: true },
        });
        return { message: 'Rule enabled successfully', rule: result };
      },
    },

    // ── Disable Rule ──────────────────────────────────────────────────────
    {
      name: 'promotions.disable_rule',
      description: 'Disable a cart price rule.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = DisableRuleSchema.parse(params);
        const client = context.getClient();
        const result = await client.put(`/V1/salesRules/${validated.rule_id}`, {
          rule: { rule_id: validated.rule_id, is_active: false },
        });
        return { message: 'Rule disabled successfully', rule: result };
      },
    },

    // ── Generate Coupons ──────────────────────────────────────────────────
    {
      name: 'promotions.generate_coupons',
      description: 'Generate coupon codes for an existing cart price rule.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = GenerateCouponsSchema.parse(params);
        guardrails.enforceCouponCap(validated.qty);
        guardrails.requireConfirmation(RiskTier.Risk, params);

        const client = context.getClient();

        const formatMap: Record<string, string> = {
          alphanumeric: 'alphanum',
          alphabetical: 'alpha',
          numeric: 'num',
        };

        const result = await client.post('/V1/salesRules/generate', {
          couponSpec: {
            rule_id: validated.rule_id,
            quantity: validated.qty,
            length: validated.length,
            format: formatMap[validated.format] || 'alphanum',
            prefix: validated.prefix || '',
          },
        });

        return {
          message: `Generated ${validated.qty} coupon(s)`,
          coupons: result,
        };
      },
    },

    // ── Export Coupons ────────────────────────────────────────────────────
    {
      name: 'promotions.export_coupons',
      description: 'Export coupon codes for a rule in CSV format.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = ExportCouponsSchema.parse(params);
        const client = context.getClient();

        // Fetch coupons for the rule
        const searchParams = client.buildSearchParams({
          filterGroups: [
            { filters: [{ field: 'rule_id', value: String(validated.rule_id), conditionType: 'eq' }] },
          ],
          pageSize: 10000,
        });

        const result = await client.get<{ items: Array<Record<string, unknown>> }>('/V1/coupons/search', searchParams);
        const items = result.items || [];

        // Convert to CSV
        const headers = ['coupon_id', 'code', 'usage_limit', 'usage_per_customer', 'times_used', 'is_primary', 'created_at', 'expiration_date'];
        const csvLines = [headers.join(',')];
        for (const item of items) {
          const row = headers.map((h) => {
            const val = item[h];
            return val !== undefined && val !== null ? String(val) : '';
          });
          csvLines.push(row.join(','));
        }

        return {
          format: 'csv',
          total_count: items.length,
          csv: csvLines.join('\n'),
        };
      },
    },
  ];
}
