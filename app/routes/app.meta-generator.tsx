import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { decrypt } from "../utils/encryption.server";
import { generateProductMeta } from "../utils/ai-content.server";
import { useState, useRef, useEffect } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShopifyProduct {
  id: string;
  handle: string;
  title: string;
  description: string;
  productType: string;
  vendor: string;
  tags: string[];
  seo: { title: string | null; description: string | null };
  featuredImage: { url: string } | null;
  variants: {
    edges: {
      node: {
        price: string;
        sku: string | null;
        barcode: string | null;
        availableForSale: boolean;
        selectedOptions: { name: string; value: string }[];
      };
    }[];
  };
}

interface GeneratedSeoItem {
  productId: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
}

interface TemplateRule {
  productType: string;
  titleTemplate: string;
  descTemplate: string;
}

// ---------------------------------------------------------------------------
// Generation helpers (deterministic / template-based)
// ---------------------------------------------------------------------------

const DEFAULT_META_TITLE_TEMPLATE = "{title} - {type} | {vendor}";
const DEFAULT_META_DESC_TEMPLATE = ""; // empty = use fallback logic

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

/** Substitute all tokens in a template string. Returns raw (untruncated) result. */
function applyTokens(
  template: string,
  product: ShopifyProduct,
  shopName: string,
): string {
  const variants = product.variants.edges.map((e) => e.node);
  const firstVariant = variants[0];

  const prices = variants
    .map((v) => parseFloat(v.price))
    .filter((p) => !isNaN(p) && p > 0);
  const price = firstVariant?.price
    ? `$${parseFloat(firstVariant.price).toFixed(2)}`
    : "";
  const priceMin = prices.length ? `$${Math.min(...prices).toFixed(2)}` : price;
  const priceMax = prices.length ? `$${Math.max(...prices).toFixed(2)}` : price;

  const sku = firstVariant?.sku || "";
  const barcode = firstVariant?.barcode || "";
  const option1 = firstVariant?.selectedOptions?.[0]?.value || "";
  const option2 = firstVariant?.selectedOptions?.[1]?.value || "";
  const option3 = firstVariant?.selectedOptions?.[2]?.value || "";
  const availability = variants.some((v) => v.availableForSale)
    ? "In Stock"
    : "Out of Stock";
  const firstTag = product.tags[0] || "";
  const year = new Date().getFullYear().toString();
  const strippedDesc = stripHtml(product.description);
  const descriptionShort = strippedDesc.slice(0, 100).trim();
  const variantCount = variants.length.toString();

  let result = template
    .replace(/{title}/g, product.title)
    .replace(/{vendor}/g, product.vendor || "")
    .replace(/{type}/g, product.productType || "")
    .replace(/{store}/g, shopName)
    .replace(/{price}/g, price)
    .replace(/{price_min}/g, priceMin)
    .replace(/{price_max}/g, priceMax)
    .replace(/{sku}/g, sku)
    .replace(/{barcode}/g, barcode)
    .replace(/{option1}/g, option1)
    .replace(/{option2}/g, option2)
    .replace(/{option3}/g, option3)
    .replace(/{availability}/g, availability)
    .replace(/{first_tag}/g, firstTag)
    .replace(/{year}/g, year)
    .replace(/{description_short}/g, descriptionShort)
    .replace(/{description}/g, strippedDesc)
    .replace(/{variant_count}/g, variantCount);

  // Clean up separators left by empty tokens e.g. " -  | Vendor" → " | Vendor"
  result = result
    .replace(/\s*[-|]\s*[-|]\s*/g, " | ")
    .replace(/^\s*[-|]\s*/, "")
    .replace(/\s*[-|]\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return result;
}

/** Select title/desc templates for a product, applying rule-based overrides. */
function selectTemplates(
  product: ShopifyProduct,
  rules: TemplateRule[],
  defaultTitle: string,
  defaultDesc: string,
): { titleTemplate: string; descTemplate: string } {
  if (rules.length > 0 && product.productType) {
    const rule = rules.find(
      (r) =>
        r.productType.trim().toLowerCase() ===
        product.productType.trim().toLowerCase(),
    );
    if (rule) {
      return {
        titleTemplate: rule.titleTemplate || defaultTitle,
        descTemplate: rule.descTemplate || defaultDesc,
      };
    }
  }
  return { titleTemplate: defaultTitle, descTemplate: defaultDesc };
}

function generateMetaTitle(
  product: ShopifyProduct,
  template: string,
  shopName: string,
): string {
  const raw = applyTokens(template || DEFAULT_META_TITLE_TEMPLATE, product, shopName);
  if (raw.length <= 60) return raw;
  const truncated = raw.slice(0, 57);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated) + "...";
}

function generateMetaDescription(
  product: ShopifyProduct,
  template: string,
  shopName: string,
): string {
  // If a template is set, use it
  if (template) {
    const raw = applyTokens(template, product, shopName);
    if (raw) {
      if (raw.length <= 155) return raw;
      const truncated = raw.slice(0, 152);
      const lastSpace = truncated.lastIndexOf(" ");
      return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + "...";
    }
  }

  // Fallback: use stripped description, then a generated sentence
  const stripped = stripHtml(product.description);
  if (stripped) {
    if (stripped.length <= 155) return stripped;
    const truncated = stripped.slice(0, 152);
    const lastSpace = truncated.lastIndexOf(" ");
    return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + "...";
  }

  const parts = [
    `Shop ${product.title}`,
    product.vendor ? `by ${product.vendor}` : null,
    product.productType ? `${product.productType}.` : null,
    "Browse our full selection and find the right fit for your needs.",
  ]
    .filter(Boolean)
    .join(" ");
  return parts.length <= 155 ? parts : parts.slice(0, 152) + "...";
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const response = await admin.graphql(`#graphql
    {
      products(first: 50) {
        edges {
          node {
            id
            handle
            title
            description
            productType
            vendor
            tags
            seo {
              title
              description
            }
            featuredImage {
              url
            }
            variants(first: 100) {
              edges {
                node {
                  price
                  sku
                  barcode
                  availableForSale
                  selectedOptions {
                    name
                    value
                  }
                }
              }
            }
          }
        }
      }
    }
  `);

  const json = await response.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const products: ShopifyProduct[] = json.data?.products?.edges?.map((e: any) => e.node) ?? [];

  const productIds = products.map((p) => p.id);
  const seoRecords = await prisma.productSeoData.findMany({
    where: { shop: session.shop, productId: { in: productIds } },
  });

  // Map productId → { applied, generatedMeta }
  const seoMap: Record<string, { applied: boolean }> = {};
  for (const r of seoRecords) {
    seoMap[r.productId] = { applied: r.applied };
  }

  const settings = await prisma.appSettings.findUnique({ where: { shop: session.shop } });

  let templateRules: TemplateRule[] = [];
  try {
    if (settings?.templateRules) templateRules = JSON.parse(settings.templateRules);
  } catch { /* ignore */ }

  return {
    products,
    seoMap,
    shop: session.shop,
    hasApiKey: !!(settings?.aiApiKey),
    metaTitleTemplate: settings?.metaTitleTemplate ?? "",
    metaDescTemplate: settings?.metaDescTemplate ?? "",
    templateRules,
  };
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // ── Generate ──
  if (intent === "generate") {
    const productIds = new Set(formData.getAll("productId") as string[]);
    const productsJson = formData.get("productsJson") as string;
    const products: ShopifyProduct[] = JSON.parse(productsJson).filter(
      (p: ShopifyProduct) => productIds.has(p.id),
    );

    const settings = await prisma.appSettings.findUnique({ where: { shop: session.shop } });
    const globalTitleTemplate = settings?.metaTitleTemplate || DEFAULT_META_TITLE_TEMPLATE;
    const globalDescTemplate = settings?.metaDescTemplate || DEFAULT_META_DESC_TEMPLATE;
    const shopName = session.shop;

    let templateRules: TemplateRule[] = [];
    try {
      if (settings?.templateRules) templateRules = JSON.parse(settings.templateRules);
    } catch { /* ignore */ }

    let decryptedKey: string | null = null;
    if (settings?.aiApiKey) {
      try { decryptedKey = decrypt(settings.aiApiKey); } catch { /* fall back to template */ }
    }

    const generated: GeneratedSeoItem[] = await Promise.all(
      products.map(async (product) => {
        if (decryptedKey) {
          try {
            const aiMeta = await generateProductMeta(
              {
                id: product.id,
                title: product.title,
                description: product.description,
                productType: product.productType,
                vendor: product.vendor,
                tags: product.tags,
                variants: product.variants,
              },
              "",
              decryptedKey,
              settings!.aiModel,
            );
            return { productId: product.id, title: product.title, ...aiMeta };
          } catch { /* fall through to template on AI error */ }
        }

        const { titleTemplate, descTemplate } = selectTemplates(
          product,
          templateRules,
          globalTitleTemplate,
          globalDescTemplate,
        );

        return {
          productId: product.id,
          title: product.title,
          metaTitle: generateMetaTitle(product, titleTemplate, shopName),
          metaDescription: generateMetaDescription(product, descTemplate, shopName),
        };
      }),
    );

    for (const item of generated) {
      await prisma.productSeoData.upsert({
        where: { shop_productId: { shop: session.shop, productId: item.productId } },
        create: {
          shop: session.shop,
          productId: item.productId,
          generatedMeta: JSON.stringify({
            metaTitle: item.metaTitle,
            metaDescription: item.metaDescription,
          }),
          applied: false,
        },
        update: {
          generatedMeta: JSON.stringify({
            metaTitle: item.metaTitle,
            metaDescription: item.metaDescription,
          }),
          applied: false,
        },
      });
    }

    return { intent: "generate", generated };
  }

  // ── Apply ──
  if (intent === "apply") {
    const itemsJson = formData.get("itemsJson") as string;
    const items: GeneratedSeoItem[] = JSON.parse(itemsJson);

    let applied = 0;
    const errors: { title: string; message: string }[] = [];

    for (const item of items) {
      try {
        const resp = await admin.graphql(
          `#graphql
          mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              product {
                id
                seo { title description }
              }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              input: {
                id: item.productId,
                seo: { title: item.metaTitle, description: item.metaDescription },
              },
            },
          },
        );

        const respJson = await resp.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const userErrors: any[] = respJson.data?.productUpdate?.userErrors ?? [];

        if (userErrors.length > 0) {
          errors.push({
            title: item.title,
            message: userErrors.map((e) => e.message).join(", "),
          });
        } else {
          applied++;
          await prisma.productSeoData.update({
            where: { shop_productId: { shop: session.shop, productId: item.productId } },
            data: { applied: true },
          });
        }

        // Avoid hitting Shopify rate limits
        await new Promise((r) => setTimeout(r, 200));
      } catch (e) {
        errors.push({ title: item.title, message: String(e) });
      }
    }

    return { intent: "apply", applied, errors };
  }

  return { error: "Unknown intent" };
};

// ---------------------------------------------------------------------------
// SERP preview
// ---------------------------------------------------------------------------

function SerpPreview({
  title,
  description,
  url,
}: {
  title: string;
  description: string;
  url: string;
}) {
  return (
    <div
      style={{
        fontFamily: "Arial, sans-serif",
        padding: "12px 14px",
        background: "#fff",
        border: "1px solid #dfe1e5",
        borderRadius: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
        <div
          style={{
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "#e8eaed",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 12,
            color: "#202124",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {url}
        </span>
      </div>
      <div
        style={{
          fontSize: 18,
          lineHeight: "1.3",
          color: title ? "#1558d6" : "#9aa0a6",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          marginBottom: 3,
          fontWeight: 400,
        }}
      >
        {title || "Meta title will appear here"}
      </div>
      <div
        style={{
          fontSize: 13,
          color: description ? "#4d5156" : "#9aa0a6",
          lineHeight: "1.58",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical" as const,
          overflow: "hidden",
        }}
      >
        {description || "Meta description will appear here."}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Indeterminate checkbox helper
// ---------------------------------------------------------------------------

function IndeterminateCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      style={{ cursor: "pointer", width: 16, height: 16 }}
    />
  );
}

// ---------------------------------------------------------------------------
// Shared card style
// ---------------------------------------------------------------------------

const CARD_STYLE: React.CSSProperties = {
  background: "white",
  border: "1px solid #e1e3e5",
  borderRadius: 8,
  padding: "16px",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MetaGenerator() {
  const { products, seoMap, hasApiKey, shop } = useLoaderData<typeof loader>();
  const handleMap = Object.fromEntries(products.map((p) => [p.id, p.handle]));
  const fetcher = useFetcher<typeof action>();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<
    Record<string, { metaTitle?: string; metaDescription?: string }>
  >({});

  const isGenerating =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "generate";
  const isApplying =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "apply";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetcherData = fetcher.data as any;
  const generatedItems: GeneratedSeoItem[] | null =
    fetcherData?.intent === "generate" ? fetcherData.generated : null;
  const applyResult =
    fetcherData?.intent === "apply"
      ? {
          applied: fetcherData.applied as number,
          errors: fetcherData.errors as { title: string; message: string }[],
        }
      : null;

  // Merge server output with in-page edits
  const displayItems: GeneratedSeoItem[] = (generatedItems ?? []).map((item) => ({
    ...item,
    metaTitle: edits[item.productId]?.metaTitle ?? item.metaTitle,
    metaDescription: edits[item.productId]?.metaDescription ?? item.metaDescription,
  }));

  const allSelected = products.length > 0 && selected.size === products.length;
  const someSelected = selected.size > 0 && !allSelected;

  function toggleAll() {
    if (allSelected || someSelected) setSelected(new Set());
    else setSelected(new Set(products.map((p) => p.id)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function seoStatus(product: ShopifyProduct): "complete" | "partial" | "missing" {
    const hasTitle = !!product.seo.title;
    const hasDesc = !!product.seo.description;
    if (hasTitle && hasDesc) return "complete";
    if (hasTitle || hasDesc) return "partial";
    return "missing";
  }

  function handleGenerate() {
    const fd = new FormData();
    fd.set("intent", "generate");
    fd.set("productsJson", JSON.stringify(products));
    selected.forEach((id) => fd.append("productId", id));
    setEdits({});
    fetcher.submit(fd, { method: "post" });
  }

  function handleApply() {
    const fd = new FormData();
    fd.set("intent", "apply");
    fd.set("itemsJson", JSON.stringify(displayItems));
    fetcher.submit(fd, { method: "post" });
  }

  const STATUS_STYLE = {
    complete: { bg: "#d4edda", color: "#155724", label: "Complete" },
    partial: { bg: "#fff3cd", color: "#856404", label: "Partial" },
    missing: { bg: "#f8d7da", color: "#721c24", label: "Missing" },
  } as const;

  return (
    <s-page heading="Meta Generator">

      {/* ── Apply result banner ── */}
      {applyResult && (
        <s-section>
          <div
            style={{
              padding: "12px 16px",
              borderRadius: 8,
              marginBottom: 8,
              background: applyResult.errors.length === 0 ? "#d4edda" : "#fff3cd",
              color: applyResult.errors.length === 0 ? "#155724" : "#856404",
            }}
          >
            {applyResult.errors.length === 0 ? (
              <>
                ✓ Applied meta tags to {applyResult.applied} product
                {applyResult.applied !== 1 ? "s" : ""} successfully.
              </>
            ) : (
              <>
                ⚠ Applied {applyResult.applied} products.{" "}
                {applyResult.errors.length} failed:{" "}
                {applyResult.errors.map((e) => `${e.title} (${e.message})`).join("; ")}
              </>
            )}
          </div>
        </s-section>
      )}

      {/* ── Preview & edit panel ── */}
      {displayItems.length > 0 && (
        <s-section heading="Preview &amp; Edit Generated Meta Tags">
          <s-stack direction="block" gap="base">
            {displayItems.map((item) => {
              const titleLen = item.metaTitle.length;
              const descLen = item.metaDescription.length;
              return (
                <div key={item.productId} style={CARD_STYLE}>
                  <s-stack direction="block" gap="base">
                    <strong style={{ fontSize: 14 }}>{item.title}</strong>

                    <div>
                      <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>
                        Meta Title
                      </div>
                      <input
                        type="text"
                        value={item.metaTitle}
                        onChange={(e) =>
                          setEdits((prev) => ({
                            ...prev,
                            [item.productId]: {
                              ...prev[item.productId],
                              metaTitle: e.target.value,
                            },
                          }))
                        }
                        style={{
                          display: "block",
                          width: "100%",
                          padding: "6px 8px",
                          border: "1px solid #c9cccf",
                          borderRadius: 4,
                          fontSize: 14,
                          boxSizing: "border-box",
                        }}
                      />
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: titleLen <= 60 ? "#008060" : "#d82c0d",
                        }}
                      >
                        {titleLen}/60 chars{titleLen > 60 ? " — too long" : " — ✓"}
                      </span>
                    </div>

                    <div>
                      <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>
                        Meta Description
                      </div>
                      <textarea
                        value={item.metaDescription}
                        onChange={(e) =>
                          setEdits((prev) => ({
                            ...prev,
                            [item.productId]: {
                              ...prev[item.productId],
                              metaDescription: e.target.value,
                            },
                          }))
                        }
                        rows={3}
                        style={{
                          display: "block",
                          width: "100%",
                          padding: "6px 8px",
                          border: "1px solid #c9cccf",
                          borderRadius: 4,
                          fontSize: 14,
                          resize: "vertical",
                          boxSizing: "border-box",
                        }}
                      />
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: descLen <= 155 ? "#008060" : "#d82c0d",
                        }}
                      >
                        {descLen}/155 chars{descLen > 155 ? " — too long" : " — ✓"}
                      </span>
                    </div>

                    <SerpPreview
                      title={item.metaTitle}
                      description={item.metaDescription}
                      url={`${shop}/products/${handleMap[item.productId] ?? ""}`}
                    />
                  </s-stack>
                </div>
              );
            })}

            <div style={{ paddingTop: 4 }}>
              <s-button
                variant="primary"
                onClick={handleApply}
              >
                {isApplying
                  ? "Applying…"
                  : `Apply to Shopify (${displayItems.length} product${displayItems.length !== 1 ? "s" : ""})`}
              </s-button>
            </div>
          </s-stack>
        </s-section>
      )}

      {/* ── Product list ── */}
      <s-section heading={`Products (${products.length})`}>

        {/* Controls bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 16,
            flexWrap: "wrap",
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <IndeterminateCheckbox
              checked={allSelected}
              indeterminate={someSelected}
              onChange={toggleAll}
            />
            <span style={{ fontSize: 14 }}>Select All</span>
          </label>

          <span style={{ fontSize: 14, color: "#6d7175" }}>
            {selected.size} of {products.length} selected
          </span>

          <s-button
            variant="primary"
            onClick={handleGenerate}
          >
            {isGenerating ? "Generating…" : "Generate Meta Tags"}
          </s-button>

          <span
            style={{
              fontSize: 12,
              padding: "3px 10px",
              borderRadius: 12,
              background: hasApiKey ? "#e3f4f4" : "#f6f6f7",
              color: hasApiKey ? "#0d4f4f" : "#6d7175",
              fontWeight: 500,
            }}
          >
            {hasApiKey ? "AI generation" : "Template generation"}
          </span>

          {!hasApiKey && (
            <a
              href="/app/settings"
              style={{ fontSize: 12, color: "#2c6ecb", textDecoration: "underline" }}
            >
              Add API key to enable AI
            </a>
          )}
        </div>

        {/* Table */}
        <div style={{ border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden" }}>
          {/* Header row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "40px 56px 1fr 190px 220px 90px",
              gap: 12,
              padding: "10px 16px",
              background: "#f6f6f7",
              fontWeight: 600,
              fontSize: 13,
              color: "#3d4044",
              borderBottom: "1px solid #e1e3e5",
            }}
          >
            <span />
            <span>Image</span>
            <span>Product</span>
            <span>SEO Title</span>
            <span>SEO Description</span>
            <span>Status</span>
          </div>

          {/* Product rows */}
          {products.map((product, idx) => {
            const status = seoStatus(product);
            const ss = STATUS_STYLE[status];
            const isApplied = seoMap[product.id]?.applied ?? false;

            return (
              <div
                key={product.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "40px 56px 1fr 190px 220px 90px",
                  gap: 12,
                  padding: "10px 16px",
                  borderBottom: idx < products.length - 1 ? "1px solid #e1e3e5" : "none",
                  alignItems: "center",
                  background: selected.has(product.id) ? "#f0f7ff" : isApplied ? "#f0fff4" : "white",
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(product.id)}
                  onChange={() => toggleOne(product.id)}
                  style={{ cursor: "pointer", width: 16, height: 16 }}
                />

                {product.featuredImage ? (
                  <img
                    src={product.featuredImage.url}
                    alt={product.title}
                    style={{
                      width: 44,
                      height: 44,
                      objectFit: "cover",
                      borderRadius: 4,
                      border: "1px solid #e1e3e5",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      background: "#f1f1f1",
                      borderRadius: 4,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 9,
                      color: "#8c9196",
                      textAlign: "center",
                      border: "1px solid #e1e3e5",
                    }}
                  >
                    No img
                  </div>
                )}

                <span style={{ fontSize: 13, color: "#3d4044" }}>{product.title}</span>

                <span style={{ fontSize: 13, color: product.seo.title ? "#3d4044" : "#8c9196" }}>
                  {product.seo.title
                    ? product.seo.title.length > 38
                      ? product.seo.title.slice(0, 38) + "…"
                      : product.seo.title
                    : "Not set"}
                </span>

                <span
                  style={{ fontSize: 13, color: product.seo.description ? "#3d4044" : "#8c9196" }}
                >
                  {product.seo.description
                    ? product.seo.description.length > 58
                      ? product.seo.description.slice(0, 58) + "…"
                      : product.seo.description
                    : "Not set"}
                </span>

                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 8px",
                    borderRadius: 12,
                    background: ss.bg,
                    color: ss.color,
                    fontSize: 12,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {ss.label}
                </span>
              </div>
            );
          })}

          {products.length === 0 && (
            <div style={{ padding: "32px 16px", textAlign: "center", color: "#8c9196" }}>
              No products found in this store.
            </div>
          )}
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
