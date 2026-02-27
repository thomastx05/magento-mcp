/**
 * CMS actions: Pages and blocks search, get, and bulk update.
 */

import { ActionDefinition, ActionContext, RiskTier } from '../protocol/types';
import {
  CmsSearchPagesSchema,
  CmsGetPageSchema,
  CmsPrepareBulkUpdatePagesSchema,
  CmsCommitBulkUpdatePagesSchema,
  CmsSearchBlocksSchema,
  CmsGetBlockSchema,
  CmsPrepareBulkUpdateBlocksSchema,
  CmsCommitBulkUpdateBlocksSchema,
} from '../validation/schemas';
import { MagentoRestClient } from '../client/magentoRest';
// Note: MagentoRestClient import kept for resolve helpers
import { PlanStore } from '../session/planStore';
import { Guardrails } from '../validation/guardrails';
import { McpConfig } from '../config';

export function createCmsActions(
  planStore: PlanStore,
  guardrails: Guardrails,
  config: McpConfig,
): ActionDefinition[] {
  return [
    // ── Search Pages ──────────────────────────────────────────────────────
    {
      name: 'cms.search_pages',
      description: 'Search CMS pages by query string.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = CmsSearchPagesSchema.parse(params);
        const client = context.getClient();

        const filterGroups: Array<{ filters: Array<{ field: string; value: string; conditionType?: string }> }> = [];
        if (validated.query) {
          filterGroups.push({
            filters: [{ field: 'title', value: `%${validated.query}%`, conditionType: 'like' }],
          });
        }

        const searchParams = client.buildSearchParams({
          filterGroups: filterGroups.length > 0 ? filterGroups : undefined,
          pageSize: validated.page_size,
          currentPage: validated.current_page,
        });

        return await client.get('/V1/cmsPage/search', searchParams);
      },
    },

    // ── Get Page ──────────────────────────────────────────────────────────
    {
      name: 'cms.get_page',
      description: 'Get a CMS page by ID.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = CmsGetPageSchema.parse(params);
        const client = context.getClient();
        return await client.get(`/V1/cmsPage/${validated.page_id}`);
      },
    },

    // ── Prepare Bulk Update Pages ─────────────────────────────────────────
    {
      name: 'cms.prepare_bulk_update_pages',
      description: 'Prepare a bulk update for CMS pages.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = CmsPrepareBulkUpdatePagesSchema.parse(params);

        guardrails.enforceAllowedFields(
          Object.keys(validated.updates),
          config.allowedCmsPageUpdateFields,
          'CMS page update',
        );

        const client = context.getClient();

        // Resolve matching pages
        const pages = await resolveMatchingPages(client, validated.match);

        const sampleDiffs = pages.slice(0, 5).map((p: Record<string, unknown>) => {
          const diff: Record<string, { from: unknown; to: unknown }> = {};
          for (const [field, newValue] of Object.entries(validated.updates)) {
            diff[field] = { from: p[field], to: newValue };
          }
          return { page_id: p['id'], title: p['title'], changes: diff };
        });

        const plan = planStore.create(
          'cms.commit_bulk_update_pages',
          {
            page_ids: pages.map((p: Record<string, unknown>) => p['id']),
            updates: validated.updates,
            scope: validated.scope,
          },
          pages.length,
          config.planExpiryMinutes,
          sampleDiffs,
        );

        return {
          plan_id: plan.plan_id,
          expires_at: plan.expires_at,
          affected_count: pages.length,
          sample_diffs: sampleDiffs,
          message: 'CMS page update plan created. Call cms.commit_bulk_update_pages to execute.',
        };
      },
    },

    // ── Commit Bulk Update Pages ──────────────────────────────────────────
    {
      name: 'cms.commit_bulk_update_pages',
      description: 'Execute a previously prepared CMS page bulk update.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = CmsCommitBulkUpdatePagesSchema.parse(params);
        guardrails.requireConfirmation(RiskTier.Risk, params);

        const plan = planStore.consume(validated.plan_id);
        if (!plan) {
          throw new Error('Plan not found or expired.');
        }

        const payload = plan.payload as { page_ids: number[]; updates: Record<string, unknown> };
        const client = context.getClient();

        let successCount = 0;
        const errors: Array<{ page_id: number; error: string }> = [];

        for (const pageId of payload.page_ids) {
          try {
            await client.put(`/V1/cmsPage/${pageId}`, {
              page: { id: pageId, ...payload.updates },
            });
            successCount++;
          } catch (err) {
            errors.push({ page_id: pageId, error: err instanceof Error ? err.message : String(err) });
          }
        }

        return {
          message: `Updated ${successCount}/${payload.page_ids.length} CMS pages.`,
          success_count: successCount,
          error_count: errors.length,
          errors: errors.length > 0 ? errors : undefined,
        };
      },
    },

    // ── Search Blocks ─────────────────────────────────────────────────────
    {
      name: 'cms.search_blocks',
      description: 'Search CMS blocks by query string.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = CmsSearchBlocksSchema.parse(params);
        const client = context.getClient();

        const filterGroups: Array<{ filters: Array<{ field: string; value: string; conditionType?: string }> }> = [];
        if (validated.query) {
          filterGroups.push({
            filters: [{ field: 'title', value: `%${validated.query}%`, conditionType: 'like' }],
          });
        }

        const searchParams = client.buildSearchParams({
          filterGroups: filterGroups.length > 0 ? filterGroups : undefined,
          pageSize: validated.page_size,
          currentPage: validated.current_page,
        });

        return await client.get('/V1/cmsBlock/search', searchParams);
      },
    },

    // ── Get Block ─────────────────────────────────────────────────────────
    {
      name: 'cms.get_block',
      description: 'Get a CMS block by ID.',
      riskTier: RiskTier.Safe,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = CmsGetBlockSchema.parse(params);
        const client = context.getClient();
        return await client.get(`/V1/cmsBlock/${validated.block_id}`);
      },
    },

    // ── Prepare Bulk Update Blocks ────────────────────────────────────────
    {
      name: 'cms.prepare_bulk_update_blocks',
      description: 'Prepare a bulk update for CMS blocks.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = CmsPrepareBulkUpdateBlocksSchema.parse(params);

        guardrails.enforceAllowedFields(
          Object.keys(validated.updates),
          config.allowedCmsBlockUpdateFields,
          'CMS block update',
        );

        const client = context.getClient();
        const blocks = await resolveMatchingBlocks(client, validated.match);

        const sampleDiffs = blocks.slice(0, 5).map((b: Record<string, unknown>) => {
          const diff: Record<string, { from: unknown; to: unknown }> = {};
          for (const [field, newValue] of Object.entries(validated.updates)) {
            diff[field] = { from: b[field], to: newValue };
          }
          return { block_id: b['id'], title: b['title'], changes: diff };
        });

        const plan = planStore.create(
          'cms.commit_bulk_update_blocks',
          {
            block_ids: blocks.map((b: Record<string, unknown>) => b['id']),
            updates: validated.updates,
            scope: validated.scope,
          },
          blocks.length,
          config.planExpiryMinutes,
          sampleDiffs,
        );

        return {
          plan_id: plan.plan_id,
          expires_at: plan.expires_at,
          affected_count: blocks.length,
          sample_diffs: sampleDiffs,
          message: 'CMS block update plan created. Call cms.commit_bulk_update_blocks to execute.',
        };
      },
    },

    // ── Commit Bulk Update Blocks ─────────────────────────────────────────
    {
      name: 'cms.commit_bulk_update_blocks',
      description: 'Execute a previously prepared CMS block bulk update.',
      riskTier: RiskTier.Risk,
      requiresAuth: true,
      handler: async (params: Record<string, unknown>, context: ActionContext) => {
        const validated = CmsCommitBulkUpdateBlocksSchema.parse(params);
        guardrails.requireConfirmation(RiskTier.Risk, params);

        const plan = planStore.consume(validated.plan_id);
        if (!plan) {
          throw new Error('Plan not found or expired.');
        }

        const payload = plan.payload as { block_ids: number[]; updates: Record<string, unknown> };
        const client = context.getClient();

        let successCount = 0;
        const errors: Array<{ block_id: number; error: string }> = [];

        for (const blockId of payload.block_ids) {
          try {
            await client.put(`/V1/cmsBlock/${blockId}`, {
              block: { id: blockId, ...payload.updates },
            });
            successCount++;
          } catch (err) {
            errors.push({ block_id: blockId, error: err instanceof Error ? err.message : String(err) });
          }
        }

        return {
          message: `Updated ${successCount}/${payload.block_ids.length} CMS blocks.`,
          success_count: successCount,
          error_count: errors.length,
          errors: errors.length > 0 ? errors : undefined,
        };
      },
    },
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function resolveMatchingPages(
  client: MagentoRestClient,
  match: { page_ids?: number[]; identifier?: string },
): Promise<Array<Record<string, unknown>>> {
  const filterGroups: Array<{ filters: Array<{ field: string; value: string; conditionType?: string }> }> = [];

  if (match.page_ids && match.page_ids.length > 0) {
    filterGroups.push({
      filters: [{ field: 'page_id', value: match.page_ids.join(','), conditionType: 'in' }],
    });
  }
  if (match.identifier) {
    filterGroups.push({
      filters: [{ field: 'identifier', value: `%${match.identifier}%`, conditionType: 'like' }],
    });
  }

  const searchParams = client.buildSearchParams({
    filterGroups: filterGroups.length > 0 ? filterGroups : undefined,
    pageSize: 200,
  });

  const result = await client.get<{ items: Array<Record<string, unknown>> }>('/V1/cmsPage/search', searchParams);
  return result.items || [];
}

async function resolveMatchingBlocks(
  client: MagentoRestClient,
  match: { block_ids?: number[]; identifier?: string },
): Promise<Array<Record<string, unknown>>> {
  const filterGroups: Array<{ filters: Array<{ field: string; value: string; conditionType?: string }> }> = [];

  if (match.block_ids && match.block_ids.length > 0) {
    filterGroups.push({
      filters: [{ field: 'block_id', value: match.block_ids.join(','), conditionType: 'in' }],
    });
  }
  if (match.identifier) {
    filterGroups.push({
      filters: [{ field: 'identifier', value: `%${match.identifier}%`, conditionType: 'like' }],
    });
  }

  const searchParams = client.buildSearchParams({
    filterGroups: filterGroups.length > 0 ? filterGroups : undefined,
    pageSize: 200,
  });

  const result = await client.get<{ items: Array<Record<string, unknown>> }>('/V1/cmsBlock/search', searchParams);
  return result.items || [];
}
