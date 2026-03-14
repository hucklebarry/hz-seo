# MetaForge SEO — Claude Code Context

## What this app does
AI-powered SEO automation for Shopify stores. Auto-generates optimized meta titles, descriptions, JSON-LD structured data, and blog content from existing product data. Built for product-heavy stores (especially B2B/commercial equipment sellers).

## Tech stack
- **Framework:** React Router v7 (Shopify's official template), file-based routing via Vite
- **Auth:** `@shopify/shopify-app-react-router` — `authenticate.admin(request)` in every loader/action
- **Shopify API version:** `2026-01`
- **Database:** SQLite via Prisma (file: `prisma/dev.sqlite`)
- **UI:** Polaris web components (`<s-page>`, `<s-card>`, `<s-text>`, `<s-button>`, etc.)

## Key conventions
- All app routes are prefixed `app.` (e.g., `app.meta-generator.tsx`) to inherit auth from `app/routes/app.tsx`
- Every route loader must call `await authenticate.admin(request)` — this handles OAuth redirect if needed
- Shopify GraphQL calls use `const { admin } = await authenticate.admin(request)` then `admin.graphql(...)`
- Export `headers` from every route using `boundary.headers(headersArgs)` from `@shopify/shopify-app-react-router/server`
- Use Polaris web components (not React Polaris components) — follow existing patterns in `app/routes/`
- Use `useFetcher` (not `useSubmit` + form) for generate/apply actions so the page doesn't navigate away

## Polaris web component type quirks
The `@shopify/polaris-types` definitions (v1.0.1) are incomplete — known mismatches:
- `s-card` is not declared in JSX.IntrinsicElements — **use a styled `<div>` instead**
- `s-text` has no `variant` prop in types (even though it works at runtime)
- `s-text` `tone` only accepts: `auto | neutral | info | success | caution | warning | critical` — **"subdued" is invalid**
- `s-stack` `gap` only accepts SpacingKeywords: `none | small-500..small-100 | small | base | large | large-100..large-500` — **"tight" and "extraTight" are invalid**
- `s-app-nav` is not in JSX.IntrinsicElements (pre-existing error in `app.tsx`)
- These TS errors exist in the pre-existing scaffolded files too — don't chase them, just avoid introducing new ones

## Prisma models
- **Session** — managed by Shopify auth library, do not modify
- **SeoJob** — tracks bulk generation jobs (status: pending/processing/completed/failed, jobType: meta_generation/schema_generation/blog_generation)
- **ProductSeoData** — stores per-product SEO output, unique on [shop, productId]

## App scopes
`read_products, write_products, read_content, write_content`

## Route map
| Route file | Path | Status |
|---|---|---|
| `app._index.tsx` | `/app` | Done — product count dashboard, quick-action buttons |
| `app.meta-generator.tsx` | `/app/meta-generator` | Done (Phase 2) — full product list, generate & apply |
| `app.schema-markup.tsx` | `/app/schema-markup` | Done (Phase 3) — JSON-LD generation, preview, apply as metafield |
| `app.settings.tsx` | `/app/settings` | Placeholder |
| `app.blog-generator.tsx` | `/app/blog-generator` | Done (Phase 4) — AI blog content generation, preview, publish to Shopify |
| `app.settings.tsx` | `/app/settings` | Done (Phase 4) — API key management, model selection, theme integration docs |
| `app.tsx` | layout | NavMenu with all 5 links |

## Meta Generator (Phase 2) — what's built
- **Loader:** fetches first 50 products via GraphQL, loads existing `ProductSeoData` from Prisma
- **Generate action:** template-based meta title (≤60 chars) and description (≤155 chars), upserts `ProductSeoData` with `applied=false`
- **Apply action:** runs `productUpdate` mutation per product with 200ms delay, marks `applied=true` in Prisma
- **UI:** checkbox table with status badges, inline-editable preview cards with live char counters, result banner
- **Generation is deterministic/template-based** — AI generation (Claude API) is deferred to a later phase

## Schema Markup (Phase 3) — what's built
- **Loader:** fetches first 50 products with full variant data (price, SKU, barcode, availability) + shop info (name, url, currencyCode); loads `generatedSchema` and `schemaApplied` from Prisma
- **Generate action:** builds valid schema.org/Product JSON-LD — single `Offer` for 1 variant, `AggregateOffer` for multi-variant; strips HTML from description; omits empty fields; upserts `ProductSeoData.generatedSchema`
- **Apply action:** saves JSON-LD as `metaforge_seo.json_ld` metafield (type: `json`) via `productUpdate` mutation; marks `schemaApplied=true` in Prisma
- **UI:** checkbox table with per-row Generate / Preview / Apply buttons + bulk controls; inline JSON-LD preview panel with Google Rich Results link, char count, and rich snippet mockup
- **Prisma:** added `schemaApplied Boolean @default(false)` to `ProductSeoData` — run `npx prisma db push` after pulling this change
- **Theme integration note:** after applying, merchants add `{{ product.metafields.metaforge_seo.json_ld.value }}` inside a `<script type="application/ld+json">` tag in their `main-product.liquid`

## Blog Generator (Phase 4) — what's built
- **New npm dep:** `@anthropic-ai/sdk`
- **New Prisma models:** `AppSettings` (shop, aiApiKey encrypted, aiModel), `GeneratedContent` (shop, contentType, title, metaDesc, body markdown, productIds, published, articleId)
- **Utilities:** `app/utils/encryption.server.ts` — AES-256-GCM encrypt/decrypt (requires `ENCRYPTION_KEY` in `.env`); `app/utils/ai-content.server.ts` — prompt builders, Claude API call, response parser
- **Settings page** (`app.settings.tsx`): API key input (password field, never returned to client), model dropdown (Haiku/Sonnet/Opus), save + test connection, encryption key setup instructions, theme integration Liquid snippet
- **Blog generator page** (`app.blog-generator.tsx`):
  - Loader: fetches 50 products + checks if API key is set + loads recent generations
  - Generate action: decrypts key → calls Claude → parses title/META/body from response
  - Publish action: fetches first blog → `articleCreate` mutation (draft, with title_tag + description_tag metafields) → saves to `GeneratedContent`
  - UI: searchable product list (max 5 selected), content type radio (buying guide/spotlight/comparison), tone + word count dropdowns, target keyword; preview panel with Edit toggle; publish button
  - Markdown→HTML conversion: custom line-by-line state machine (no library), supports H1-H3, bold/italic, code, lists
- **Nav:** added Blog Generator link between Schema Markup and Settings
- **Required env var:** `ENCRYPTION_KEY` — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and add to `.env`

## Dev setup
**First time:**
```bash
shopify app dev --reset   # interactive: creates Partners app, selects dev store
```

**After initial setup:**
```bash
shopify app dev            # starts local dev server, tunnels to Shopify
```

**DB changes:**
```bash
npx prisma db push         # sync schema changes to SQLite
npx prisma studio          # GUI to inspect the DB
```

## Important: shopify CLI must be interactive
`shopify app init` and the first `shopify app dev` require an interactive terminal — they prompt for Partners org and dev store selection. These cannot be run non-interactively (e.g., via Claude Code's Bash tool). Run them directly in your terminal.

## Testing
- Only test on a **development store** — live stores require app review or custom app setup
- Dev stores are free permanent sandboxes in your Partners account
- Install the app via the URL printed by `shopify app dev`
