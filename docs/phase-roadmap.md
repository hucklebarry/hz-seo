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

## Phase 2: Meta Tag Generator ✅
- Product list UI (first 50 products) with select-all and per-row status
- Generate meta titles/descriptions from template; AI generation enabled when Anthropic API key is configured
- Preview + inline edit generated tags before applying
- Apply via `productUpdate` mutation (`seo { title, description }`)
- Persist generated results in `ProductSeoData` with `applied` flag

## Phase 3: Schema Markup / JSON-LD ✅
- Generate `Product` JSON-LD structured data (Offer/AggregateOffer based on variants)
- Apply via Shopify metafield `metaforge_seo.json_ld` (type `json`)
- Per-product preview with Google Rich Results Test link
- Persist JSON-LD + `schemaApplied` in `ProductSeoData`

## Phase 4: Blog / Content Generation ✅
- Generate SEO blog posts using Anthropic (Claude) with tone/word count/keyword options
- Publish as draft articles via Shopify Blog API (`read_content`, `write_content`)
- Store generated content in `GeneratedContent` with publish status

## Phase 5: Analytics & Reporting (planned)
- Track which products have had SEO applied
- Show before/after meta tag comparison
- Integration with Google Search Console (optional)
