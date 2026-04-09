# Phase 6 — World-Class Template Engine

## Goal
Make the template-based SEO system the most powerful and customizable on the Shopify App Store, with AI as an optional enhancement layer on top of a solid template foundation.

## What's being built

### 1. Expanded token vocabulary (18 tokens)

| Token | Description |
|---|---|
| `{title}` | Product title |
| `{vendor}` | Brand/vendor name |
| `{type}` | Product type/category |
| `{store}` | Store name |
| `{price}` | Starting price (first variant, formatted e.g. `$49.99`) |
| `{price_min}` | Lowest variant price |
| `{price_max}` | Highest variant price |
| `{sku}` | First variant SKU |
| `{barcode}` | First variant barcode |
| `{option1}` | First option value of first variant (e.g. size, color) |
| `{option2}` | Second option value of first variant |
| `{option3}` | Third option value of first variant |
| `{availability}` | "In Stock" or "Out of Stock" |
| `{first_tag}` | First product tag |
| `{year}` | Current year (e.g. `2026`) |
| `{description_short}` | First 100 chars of stripped description |
| `{description}` | Full stripped description |
| `{variant_count}` | Total number of variants |

### 2. Configurable description template
- Previously hardcoded. Now a separate template field with the same token system.
- Stored in `AppSettings.metaDescTemplate`.
- Default (empty) falls back to existing description logic.

### 3. Product-type conditional templates (rule-based routing)
- Merchants define rules: "for product type X, use title template A and desc template B"
- Rules matched case-insensitively against `product.productType`
- Falls back to the global default templates if no rule matches
- Stored as JSON in `AppSettings.templateRules`: `[{productType, titleTemplate, descTemplate}]`

## Competitive context

| Feature | Smart SEO | SEO Manager | Booster SEO | MetaForge (Phase 6) |
|---|---|---|---|---|
| Template tokens | ~12 (product + shop level) | Exists, not public | ~5 basic | **18 (incl. variant-level)** |
| Desc template | Yes | Yes | Yes | **Yes** |
| Rule-based by collection | Yes | No | No | — |
| Rule-based by product type | **No** | No | No | **Yes** |
| SKU/barcode/option tokens | Yes (Smart SEO) | Unknown | No | **Yes** |
| AI + template hybrid | No | No | No | Planned (Phase 7) |

## Files changed

- `prisma/schema.prisma` — added `metaDescTemplate String?`, `templateRules String?` to `AppSettings`
- `app/routes/app.meta-generator.tsx` — expanded `ShopifyProduct` interface, new `applyTokens` engine, `selectTemplates` rule routing, updated GraphQL query and loader/action
- `app/routes/app.settings.tsx` — desc template field, template rules UI (add/remove per product type)

## DB migration
After pulling: `npx prisma db push`

## Status
- [x] Plan doc
- [x] Prisma schema
- [x] Token engine (meta-generator)
- [x] Settings UI (desc template + rules)
- [x] prisma db push

## Next (Phase 7 candidates)
- AI "Enhance" mode: template generates structure, AI polishes copy
- Google Search Console integration (impressions/clicks per product in-app)
- SERP visual preview (live-updating mockup as merchant edits template)
- Keyword field per rule (inject target keyword into template slot)
