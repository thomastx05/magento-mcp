# Magento MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for **Adobe Commerce / Magento 2** administration. Connects AI assistants like Claude, Windsurf, Cursor, and other MCP-compatible clients to your Magento instance for business-level operations — catalog management, promotions, CMS, diagnostics, and more.

## Features

- **30+ tools** for Magento administration via the standard MCP protocol
- **OAuth 1.0 (HMAC-SHA256)** integration authentication — no 2FA prompts
- **Two-phase commit** for bulk operations (prepare → review → commit)
- **Built-in guardrails** — bulk caps, price change warnings, confirmation requirements
- **Multi-store aware** — explicit scope handling for websites, stores, and store views
- **Audit logging** — every action logged with timestamps, user, and parameters

## Available Tools

### Auth & Scope
- `auth.login` / `auth.logout` / `auth.whoami` — session management
- `scope.list_websites_stores` / `scope.set_default` — multi-store scope

### Catalog
- `catalog.search_products` — search with filters, pagination, field projection
- `catalog.get_product` — full product details by SKU
- `catalog.prepare_bulk_update` / `catalog.commit_bulk_update` — two-phase bulk product updates

### Pricing
- `pricing.prepare_bulk_price_update` / `pricing.commit_bulk_price_update` — safe bulk price changes with threshold warnings

### Promotions
- `promotions.search_rules` / `promotions.get_rule` — find and inspect cart price rules
- `promotions.prepare_cart_price_rule_create` / `promotions.commit_cart_price_rule_create` — create rules safely
- `promotions.update_rule` / `promotions.enable_rule` / `promotions.disable_rule`
- `promotions.generate_coupons` / `promotions.export_coupons`

### CMS
- `cms.search_pages` / `cms.get_page` — find and read CMS pages
- `cms.prepare_bulk_update_pages` / `cms.commit_bulk_update_pages`
- `cms.search_blocks` / `cms.get_block`
- `cms.prepare_bulk_update_blocks` / `cms.commit_bulk_update_blocks`

### SEO
- `seo.prepare_bulk_update_url_keys` / `seo.commit_bulk_update_url_keys` — URL key changes with collision detection
- `seo.bulk_update_meta` — bulk meta title/description/keyword updates
- `seo.report_redirect_chains` — find redirect chain issues

### Diagnostics
- `diagnostics.product_display_check` — why isn't my product showing?
- `diagnostics.indexer_status_report` — indexer health check
- `diagnostics.inventory_salable_report` — MSI stock/salable quantity

### Cache
- `cache.purge_by_url` / `cache.purge_product` / `cache.purge_category` — targeted cache invalidation (Fastly or fallback)

## Quick Start

### Prerequisites

- Node.js 18+
- A Magento 2 / Adobe Commerce instance
- An [Integration](https://experienceleague.adobe.com/docs/commerce-admin/systems/integrations.html) configured in Magento with appropriate API permissions

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/magento-mcp.git
cd magento-mcp
npm install
npm run build
```

### Magento Integration Setup

1. In Magento Admin, go to **System > Integrations > Add New Integration**
2. Give it a name (e.g., "MCP Server")
3. Under **API**, select the resources you want to expose
4. Save and **Activate** the integration
5. Copy the four OAuth credentials:
   - Consumer Key
   - Consumer Secret
   - Access Token
   - Access Token Secret

### MCP Client Configuration

Add to your MCP client config (e.g., `mcp_config.json` for Windsurf, `claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "magento-mcp": {
      "command": "node",
      "args": ["C:/path/to/magento-mcp/dist/index.js"],
      "env": {
        "MAGENTO_BASE_URL": "https://your-magento-instance.com",
        "MAGENTO_OAUTH_CONSUMER_KEY": "your_consumer_key",
        "MAGENTO_OAUTH_CONSUMER_SECRET": "your_consumer_secret",
        "MAGENTO_OAUTH_TOKEN": "your_access_token",
        "MAGENTO_OAUTH_TOKEN_SECRET": "your_access_token_secret"
      }
    }
  }
}
```

### Alternative: Username/Password Auth

If you prefer admin token auth instead of OAuth (requires handling 2FA if enabled):

```json
{
  "env": {
    "MAGENTO_BASE_URL": "https://your-magento-instance.com",
    "MAGENTO_ADMIN_USERNAME": "your_admin_user",
    "MAGENTO_ADMIN_PASSWORD": "your_admin_password"
  }
}
```

## Usage

Once configured, call `auth.login` first to establish a session, then use any tool:

```
> auth.login
Login successful (OAuth 1.0 integration)

> catalog.search_products { filters: { name: { value: "%eye drops%", condition: "like" } } }
Found 12 products...

> diagnostics.inventory_salable_report { sku: "PROD-001" }
Qty: 3,805 | In Stock: Yes | Backorders: Enabled
```

## Architecture

```
src/
  index.ts              # MCP server entry point (McpServer + StdioServerTransport)
  config.ts             # Configuration & guardrail defaults
  actions/              # Tool handlers (one file per domain)
    auth.ts
    catalog.ts
    pricing.ts
    promotions.ts
    cms.ts
    seo.ts
    diagnostics.ts
    cache.ts
    scope.ts
  client/
    magentoRest.ts      # REST client with OAuth 1.0 signing
    fastlyClient.ts     # Optional Fastly CDN integration
  session/
    sessionStore.ts     # In-memory session & OAuth credential storage
    planStore.ts        # Two-phase commit plan storage
    idempotencyLedger.ts
  validation/
    schemas.ts          # Zod input schemas for all tools
    guardrails.ts       # Safety checks (bulk caps, price thresholds, confirmations)
  protocol/
    types.ts            # TypeScript interfaces
  audit/
    auditLogger.ts      # Action audit trail (JSONL)
```

## Security

- **No credentials stored on disk** — OAuth tokens are passed via environment variables and kept in memory only
- **Magento ACL enforced** — the integration's API permissions control what the server can do
- **Guardrails on top** — bulk operation caps, price change thresholds, and confirmation requirements provide defense-in-depth
- **Two-phase commit** — destructive bulk operations require explicit review and confirmation
- **Audit trail** — every action is logged with timestamp, user, parameters, and result

## Configuration

Guardrails and limits are configurable in `src/config.ts`:

| Setting | Default | Description |
|---------|---------|-------------|
| `maxBulkSkus` | 500 | Max products per bulk update |
| `maxCouponQty` | 1000 | Max coupons per generation |
| `priceChangeThreshold` | 0.5 (50%) | Warning threshold for price changes |
| `allowedCatalogUpdateFields` | name, description, status, visibility, ... | Whitelist for bulk catalog updates |

## Optional: Fastly CDN Integration

For targeted cache purge via Fastly, add these environment variables:

```json
{
  "env": {
    "FASTLY_SERVICE_ID": "your_service_id",
    "FASTLY_API_TOKEN": "your_api_token"
  }
}
```

## License

MIT
