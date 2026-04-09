import type { ProductForContent } from "./ai-content.server";

type Variant = {
  price?: string | null;
  sku?: string | null;
  barcode?: string | null;
  availableForSale?: boolean | null;
  selectedOptions?: { name: string; value: string }[] | null;
};

export interface ProductForSeo {
  id: string;
  title: string;
  description: string;
  productType: string;
  vendor: string;
  tags: string[];
  handle: string;
  seo?: { title?: string | null; description?: string | null };
  variants: { edges: { node: Variant }[] };
  featuredImage?: { url: string } | null;
  images?: { edges: { node: { url: string } }[] };
  options?: { name: string; values: string[] }[];
}

export interface ShopInfo {
  name: string;
  url: string;
  currencyCode: string;
}

export interface TemplateRule {
  productType: string;
  titleTemplate: string;
  descTemplate: string;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function priceNumber(value?: string | null): number | null {
  if (!value) return null;
  const n = parseFloat(value);
  return Number.isNaN(n) ? null : n;
}

function optionValue(variant: Variant | undefined, idx: number): string {
  const opt = variant?.selectedOptions?.[idx];
  return opt?.value ?? "";
}

function applyTemplate(template: string, product: ProductForSeo, shop: ShopInfo): string {
  if (!template) return "";

  const variants = product.variants.edges.map((e) => e.node);
  const firstVariant = variants[0];
  const prices = variants.map((v) => priceNumber(v.price)).filter((v): v is number => v !== null);
  const lowPrice = prices.length ? Math.min(...prices) : null;
  const highPrice = prices.length ? Math.max(...prices) : null;
  const price = firstVariant?.price ? `$${firstVariant.price}` : "";
  const priceMin = lowPrice !== null ? `$${lowPrice}` : "";
  const priceMax = highPrice !== null ? `$${highPrice}` : "";
  const year = new Date().getFullYear().toString();
  const availability = variants.some((v) => v.availableForSale) ? "In Stock" : "Out of Stock";
  const description = stripHtml(product.description);
  const descriptionShort = description.slice(0, 100);

  let result = template
    .replace(/{title}/g, product.title)
    .replace(/{vendor}/g, product.vendor || shop.name)
    .replace(/{type}/g, product.productType || "")
    .replace(/{store}/g, shop.name)
    .replace(/{price}/g, price)
    .replace(/{price_min}/g, priceMin)
    .replace(/{price_max}/g, priceMax)
    .replace(/{sku}/g, firstVariant?.sku ?? "")
    .replace(/{barcode}/g, firstVariant?.barcode ?? "")
    .replace(/{option1}/g, optionValue(firstVariant, 0))
    .replace(/{option2}/g, optionValue(firstVariant, 1))
    .replace(/{option3}/g, optionValue(firstVariant, 2))
    .replace(/{availability}/g, availability)
    .replace(/{first_tag}/g, product.tags?.[0] ?? "")
    .replace(/{year}/g, year)
    .replace(/{description_short}/g, descriptionShort)
    .replace(/{description}/g, description)
    .replace(/{variant_count}/g, String(variants.length));

  result = result
    .replace(/\s*[-|]\s*[-|]\s*/g, " | ")
    .replace(/^\s*[-|]\s*/, "")
    .replace(/\s*[-|]\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return result;
}

function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const truncated = s.slice(0, max - 3);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated) + "...";
}

export function generateMetaForProduct(
  product: ProductForSeo,
  shop: ShopInfo,
  defaultTitleTemplate: string,
  defaultDescTemplate: string,
  rules: TemplateRule[],
): { metaTitle: string; metaDescription: string } {
  const match = rules.find(
    (r) =>
      r.productType &&
      product.productType &&
      r.productType.toLowerCase() === product.productType.toLowerCase(),
  );

  const titleTemplate = match?.titleTemplate || defaultTitleTemplate;
  const descTemplate = match?.descTemplate || defaultDescTemplate;

  let metaTitle = applyTemplate(titleTemplate, product, shop);
  if (!metaTitle) {
    metaTitle = applyTemplate("{title} - {type} | {vendor}", product, shop);
  }
  metaTitle = truncateAtWord(metaTitle, 60);

  let metaDescription = descTemplate
    ? applyTemplate(descTemplate, product, shop)
    : stripHtml(product.description);

  if (!metaDescription) {
    const parts = [
      `Shop ${product.title}`,
      product.vendor ? `by ${product.vendor}` : null,
      product.productType ? `${product.productType}.` : null,
      "Browse our selection today.",
    ]
      .filter(Boolean)
      .join(" ");
    metaDescription = parts;
  }

  metaDescription = truncateAtWord(metaDescription, 155);

  return { metaTitle, metaDescription };
}

export function generateJsonLd(product: ProductForSeo, shop: ShopInfo): string {
  const variants = product.variants.edges.map((e) => e.node);
  const firstVariant = variants[0] ?? null;

  const prices = variants
    .map((v) => priceNumber(v.price))
    .filter((p): p is number => p !== null);
  const lowPrice = prices.length > 0 ? Math.min(...prices) : null;
  const highPrice = prices.length > 0 ? Math.max(...prices) : null;
  const anyAvailable = variants.some((v) => v.availableForSale);

  const rawDesc = stripHtml(product.description);
  const desc = rawDesc.length > 500 ? rawDesc.slice(0, 497) + "..." : rawDesc || null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema: Record<string, any> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
  };

  if (desc) schema.description = desc;

  const allImageUrls = product.images?.edges?.map((e) => e.node.url).filter(Boolean) ?? [];
  if (allImageUrls.length === 1) {
    schema.image = allImageUrls[0];
  } else if (allImageUrls.length > 1) {
    schema.image = allImageUrls;
  } else if (product.featuredImage?.url) {
    schema.image = product.featuredImage.url;
  }

  if (firstVariant?.sku) schema.sku = firstVariant.sku;
  if (firstVariant?.barcode) schema.gtin = firstVariant.barcode;

  const additionalProperties = (product.options ?? [])
    .filter((opt) => opt.values.length > 0 && opt.name.toLowerCase() !== "title")
    .map((opt) => ({
      "@type": "PropertyValue",
      name: opt.name,
      value: opt.values.join(", "),
    }));
  if (additionalProperties.length > 0) {
    schema.additionalProperty = additionalProperties;
  }

  schema.brand = {
    "@type": "Brand",
    name: product.vendor || shop.name,
  };

  const productUrl = `${shop.url}/products/${product.handle}`;
  const availability = anyAvailable
    ? "https://schema.org/InStock"
    : "https://schema.org/OutOfStock";

  if (variants.length === 1 && firstVariant) {
    schema.offers = {
      "@type": "Offer",
      url: productUrl,
      priceCurrency: shop.currencyCode,
      price: firstVariant.price,
      availability,
    };
  } else if (lowPrice !== null && highPrice !== null) {
    schema.offers = {
      "@type": "AggregateOffer",
      url: productUrl,
      priceCurrency: shop.currencyCode,
      lowPrice: String(lowPrice),
      highPrice: String(highPrice),
      offerCount: variants.length,
      availability,
    };
  }

  return JSON.stringify(schema, null, 2);
}

export function mapProductFromWebhook(payload: Record<string, unknown>): ProductForSeo {
  const variants = Array.isArray(payload.variants) ? payload.variants : [];
  return {
    id: String(payload.admin_graphql_api_id ?? payload.id ?? ""),
    title: String(payload.title ?? ""),
    description: String(payload.body_html ?? payload.description ?? ""),
    productType: String(payload.product_type ?? ""),
    vendor: String(payload.vendor ?? ""),
    tags: typeof payload.tags === "string" ? payload.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
    handle: String(payload.handle ?? ""),
    variants: {
      edges: variants.map((v: any) => ({
        node: {
          price: v?.price ?? null,
          sku: v?.sku ?? null,
          barcode: v?.barcode ?? null,
          availableForSale: v?.available ?? v?.available_for_sale ?? null,
          selectedOptions: v?.option1
            ? [
                { name: "option1", value: v.option1 },
                { name: "option2", value: v.option2 ?? "" },
                { name: "option3", value: v.option3 ?? "" },
              ]
            : null,
        },
      })),
    },
    featuredImage: payload.image?.src ? { url: String(payload.image.src) } : null,
    images: Array.isArray(payload.images)
      ? { edges: payload.images.map((img: any) => ({ node: { url: String(img.src ?? "") } })) }
      : { edges: [] },
    options: Array.isArray(payload.options)
      ? payload.options.map((opt: any) => ({ name: String(opt?.name ?? ""), values: opt?.values ?? [] }))
      : [],
  };
}
