# MetaForge SEO — Architecture & Data Flow

## Overview
MetaForge SEO is a Shopify embedded app built on React Router v7 and Shopify App Bridge web components. It provides deterministic and AI-assisted SEO tooling for product meta tags, JSON-LD schema markup, and blog post generation. Data is stored via Prisma in SQLite for development (PostgreSQL in production).

Key principles:
- Every `/app/*` route is authenticated via `authenticate.admin(request)`.
- Shopify Admin GraphQL is the primary API surface.
- App state is persisted in Prisma per shop.
- AI features are optional and gated by an encrypted Anthropic API key.

## Runtime Stack
- React Router v7 app (`@react-router/*`)
- Shopify app runtime (`@shopify/shopify-app-react-router`)
- Prisma + SQLite (dev) or Postgres (prod)
- UI via Polaris web components (`<s-page>`, `<s-section>`, `<s-button>`, etc.)

## Auth & Sessions
- Session storage uses `PrismaSessionStorage` in `app/shopify.server.ts`.
- OAuth and session handling are managed by Shopify’s library.
- All loaders/actions call `authenticate.admin(request)` to enforce auth.

## Data Model (Prisma)
- `Session`: Shopify auth sessions (managed by Shopify library)
- `SeoJob`: Tracks bulk job progress, errors, and status
- `ProductSeoData`: Per-product SEO state (generated meta, JSON-LD, applied flags)
- `AppSettings`: Per-shop settings (encrypted API key, model, templates)
- `GeneratedContent`: AI-generated blog posts (title/meta/body, published state)
- `AutomationRule`: Per-shop automation rule flags
- `SeoChangeQueue`: Pending/applied SEO changes for review

## Feature Flows

### 1) Meta Generator (AI + Template Fallback)
Route: `app/routes/app.meta-generator.tsx`

Loader:
- Fetch first 50 products with SEO fields and basic metadata.
- Load `ProductSeoData` for those products.
- Load `AppSettings` for API key + title template.

Action — Generate:
- If `AppSettings.aiApiKey` exists, decrypt and use Anthropic to generate meta.
- If AI fails or no key, fall back to template-based generation.
- Persist generated meta in `ProductSeoData` with `applied=false`.

Action — Apply:
- Call `productUpdate` with `seo { title, description }` for each product.
- Mark `applied=true` in `ProductSeoData`.

Notes:
- Generation is per-product and can be previewed/edited before apply.
- Rate limiting is handled with a 200ms delay between mutations.

### 2) Schema Markup (JSON-LD)
Route: `app/routes/app.schema-markup.tsx`

Loader:
- Fetch first 50 products with variants, images, options.
- Fetch shop info (name, URL, currencyCode).
- Load `ProductSeoData` for generated schema and applied state.

Action — Generate:
- Build schema.org/Product JSON-LD.
- Use `Offer` for single-variant; `AggregateOffer` for multi-variant.
- Persist JSON-LD in `ProductSeoData` with `schemaApplied=false`.

Action — Apply:
- Save JSON-LD to `metaforge_seo.json_ld` metafield (type `json`).
- Mark `schemaApplied=true` in `ProductSeoData`.

Notes:
- Theme integration requires rendering the metafield in Liquid.
- Preview includes a rich snippet mockup and JSON-LD block.

### 3) Blog Generator (Claude)
Route: `app/routes/app.blog-generator.tsx`

Loader:
- Fetch first 50 products.
- Check for configured AI key in `AppSettings`.
- Load recent `GeneratedContent` entries.

Action — Generate:
- Decrypt API key.
- Build system/user prompts from product data and user options.
- Call Anthropic model from settings (`aiModel`).
- Parse `# H1` + `META:` line and return Markdown body.

Action — Publish:
- Convert Markdown to HTML.
- Create Shopify article in the first blog.
- Save to `GeneratedContent` with `published=true` and `articleId`.

Notes:
- Articles are created as drafts (`isPublished: false`).
- Markdown parsing is custom and intentionally minimal.

### 4) Dashboard Bulk Operations
Route: `app/routes/app._index.tsx`

- Calculates SEO health score (meta titles, descriptions, schema coverage).
- Bulk generate/apply meta tags or schema in batches of 10.
- Tracks job progress in `SeoJob` with errors JSON.
- Runs lightweight, in-memory SEO quality checks (duplicates, missing, over-length, schema coverage) for the first 50 products.

### 5) Automation + Approval Queue
Routes:
- `app/routes/app.approval-queue.tsx` — review/apply/skip pending changes
- `app/routes/webhooks.products.create.tsx` — enqueue changes on product create
- `app/routes/app.settings.tsx` — automation settings + manual “Run Now”

Notes:
- Webhook enqueues changes; auto-apply is only performed in “Run Now” (admin context).

## Webhooks
- `app/uninstalled`: Deletes sessions on uninstall.
- `app/scopes_update`: Updates stored scope in `Session`.

Configured in `shopify.app.toml` with API version `2026-04`.

## External APIs
- Shopify Admin GraphQL (products, productUpdate, blogs, articleCreate)
- Anthropic Claude API (meta + blog generation)
- Google Search Console API (OAuth + search analytics metrics)

## Configuration
- `ENCRYPTION_KEY` is required for AI key storage (AES-256-GCM).
- `SHOP_CUSTOM_DOMAIN` optionally allows non-`myshopify.com` shops.
- Google Search Console OAuth requires `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`.

## Known Constraints
- Only the first 50 products are loaded in UI routes.
- Bulk operations are template-based (AI only in Meta Generator page).
- UI uses Shopify web components; some types are missing in `@shopify/polaris-types`.
- Settings page Liquid snippet currently omits `.value`; README shows the correct metafield access for JSON (`product.metafields.metaforge_seo.json_ld.value`).
