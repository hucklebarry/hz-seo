# MetaForge SEO — Phase Roadmap

## Phase 1: Scaffold & Auth ✅
- Shopify React Router template cloned and configured
- Prisma schema: `Session`, `SeoJob`, `ProductSeoData`
- Dashboard at `/app` showing product count
- Nav: Dashboard, Meta Generator, Schema Markup, Settings
- Scopes: `read_products`, `write_products`, `read_content`, `write_content`
- API version: `2026-01`

**To activate:** Run `shopify app dev --reset` in your terminal to link to Partners org and dev store.

---

## Phase 2: Meta Tag Generator (planned)
- Product list UI with pagination
- Bulk select products
- Call AI (Claude API) to generate `metaTitle` + `metaDescription` per product
- Preview generated tags before applying
- Apply via `productUpdate` mutation (SEO metafields)
- Store results in `ProductSeoData`
- Track job progress in `SeoJob`

## Phase 3: Schema Markup / JSON-LD (planned)
- Generate `Product` JSON-LD structured data
- Inject via Shopify metafields or theme app extension
- Support: Product, BreadcrumbList, Organization types

## Phase 4: Blog / Content Generation (planned)
- Generate SEO blog posts from product collections
- Use Shopify's blog/article API (`read_content`, `write_content`)
- Schedule and publish

## Phase 5: Analytics & Reporting (planned)
- Track which products have had SEO applied
- Show before/after meta tag comparison
- Integration with Google Search Console (optional)
