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

## Prisma models
- **Session** — managed by Shopify auth library, do not modify
- **SeoJob** — tracks bulk generation jobs (status: pending/processing/completed/failed, jobType: meta_generation/schema_generation/blog_generation)
- **ProductSeoData** — stores per-product SEO output, unique on [shop, productId]

## App scopes
`read_products, write_products, read_content, write_content`

## Route map
| Route file | Path | Status |
|---|---|---|
| `app._index.tsx` | `/app` | Done — shows product count dashboard |
| `app.meta-generator.tsx` | `/app/meta-generator` | Placeholder |
| `app.schema-markup.tsx` | `/app/schema-markup` | Placeholder |
| `app.settings.tsx` | `/app/settings` | Placeholder |
| `app.tsx` | layout | NavMenu with all 4 links |

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
