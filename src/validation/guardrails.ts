/**
 * Guardrails enforcement for Magento MCP.
 * Enforces bulk caps, price thresholds, confirmation requirements, etc.
 */

import { McpConfig } from '../config';
import { RiskTier, ErrorCodes } from '../protocol/types';

export class GuardrailError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GuardrailError';
  }
}

export class Guardrails {
  constructor(private config: McpConfig) {}

  /**
   * Enforce Tier 2+ confirmation requirement.
   */
  requireConfirmation(riskTier: RiskTier, params: Record<string, unknown>): void {
    if (riskTier >= RiskTier.Risk && this.config.tier2ConfirmationRequired) {
      if (params['confirm'] !== true) {
        throw new GuardrailError(
          ErrorCodes.CONFIRMATION_REQUIRED,
          `This action requires confirm: true and a reason string (Risk Tier ${riskTier}).`,
        );
      }
      if (!params['reason'] || typeof params['reason'] !== 'string' || (params['reason'] as string).trim().length === 0) {
        throw new GuardrailError(
          ErrorCodes.CONFIRMATION_REQUIRED,
          'A non-empty reason string is required for Tier 2+ operations.',
        );
      }
    }
  }

  /**
   * Enforce bulk SKU cap.
   */
  enforceBulkSkuCap(count: number): void {
    if (count > this.config.maxSkusPerBulkCommit) {
      throw new GuardrailError(
        ErrorCodes.BULK_CAP_EXCEEDED,
        `Bulk operation affects ${count} SKUs, exceeding the cap of ${this.config.maxSkusPerBulkCommit}. Reduce scope or increase the cap via config.`,
        { count, cap: this.config.maxSkusPerBulkCommit },
      );
    }
  }

  /**
   * Enforce coupon generation cap.
   */
  enforceCouponCap(qty: number): void {
    if (qty > this.config.maxCouponQtyPerGeneration) {
      throw new GuardrailError(
        ErrorCodes.BULK_CAP_EXCEEDED,
        `Coupon quantity ${qty} exceeds the cap of ${this.config.maxCouponQtyPerGeneration}.`,
        { qty, cap: this.config.maxCouponQtyPerGeneration },
      );
    }
  }

  /**
   * Enforce discount percent limit.
   */
  enforceDiscountLimit(simpleAction: string, discountAmount: number): void {
    if (simpleAction === 'by_percent' && discountAmount > this.config.maxDiscountPercent) {
      throw new GuardrailError(
        ErrorCodes.VALIDATION_ERROR,
        `Discount of ${discountAmount}% exceeds the maximum of ${this.config.maxDiscountPercent}%. Use override if intentional.`,
        { discountAmount, cap: this.config.maxDiscountPercent },
      );
    }
  }

  /**
   * Warn if price change exceeds threshold.
   */
  checkPriceChangeThreshold(
    currentPrice: number,
    newPrice: number,
  ): string | null {
    if (currentPrice === 0) return null;
    const pctChange = Math.abs((newPrice - currentPrice) / currentPrice) * 100;
    if (pctChange > this.config.priceChangeThresholdPercent) {
      return `Price change of ${pctChange.toFixed(1)}% exceeds the ${this.config.priceChangeThresholdPercent}% threshold warning.`;
    }
    return null;
  }

  /**
   * Validate that update fields are in the allowed whitelist.
   */
  enforceAllowedFields(
    updateFields: string[],
    allowedFields: string[],
    context: string,
  ): void {
    const disallowed = updateFields.filter((f) => !allowedFields.includes(f));
    if (disallowed.length > 0) {
      throw new GuardrailError(
        ErrorCodes.VALIDATION_ERROR,
        `${context}: Fields not allowed for update: ${disallowed.join(', ')}`,
        { disallowed, allowed: allowedFields },
      );
    }
  }

  /**
   * Ensure scope is explicitly provided for write operations.
   */
  requireExplicitScope(params: Record<string, unknown>): void {
    const scope = params['scope'] as Record<string, unknown> | undefined;
    if (!scope) {
      throw new GuardrailError(
        ErrorCodes.VALIDATION_ERROR,
        'Scope must be explicitly specified for write operations (website_code, store_code, store_view_code, or scope: "global").',
      );
    }
    const hasScope = scope['website_code'] || scope['store_code'] || scope['store_view_code'] || scope['scope'] === 'global';
    if (!hasScope) {
      throw new GuardrailError(
        ErrorCodes.VALIDATION_ERROR,
        'At least one scope field must be specified.',
      );
    }
  }
}
