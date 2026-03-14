import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { useState, useRef, useEffect } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShopifyVariant {
  price: string;
  compareAtPrice: string | null;
  sku: string | null;
  barcode: string | null;
  availableForSale: boolean;
}

interface SchemaProduct {
  id: string;
  title: string;
  description: string;
  vendor: string;
  handle: string;
  featuredImage: { url: string } | null;
  variants: { edges: { node: ShopifyVariant }[] };
}

interface ShopInfo {
  name: string;
  url: string;
  currencyCode: string;
}

interface GeneratedSchemaItem {
  productId: string;
  title: string;
  jsonLd: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function generateJsonLd(product: SchemaProduct, shop: ShopInfo): string {
  const variants = product.variants.edges.map((e) => e.node);
  const firstVariant = variants[0] ?? null;

  const prices = variants
    .map((v) => parseFloat(v.price))
    .filter((p) => !isNaN(p));
  const lowPrice = prices.length > 0 ? Math.min(...prices) : null;
  const highPrice = prices.length > 0 ? Math.max(...prices) : null;
  const anyAvailable = variants.some((v) => v.availableForSale);

  const rawDesc = stripHtml(product.description);
  const desc =
    rawDesc.length > 500 ? rawDesc.slice(0, 497) + "..." : rawDesc || null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema: Record<string, any> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
  };

  if (desc) schema.description = desc;
  if (product.featuredImage?.url) schema.image = product.featuredImage.url;
  if (firstVariant?.sku) schema.sku = firstVariant.sku;
  if (firstVariant?.barcode) schema.gtin = firstVariant.barcode;

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

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const [productsResp, shopResp] = await Promise.all([
    admin.graphql(`#graphql
      {
        products(first: 50) {
          edges {
            node {
              id
              title
              description
              vendor
              handle
              featuredImage {
                url
              }
              variants(first: 100) {
                edges {
                  node {
                    price
                    compareAtPrice
                    sku
                    barcode
                    availableForSale
                  }
                }
              }
            }
          }
        }
      }
    `),
    admin.graphql(`#graphql
      {
        shop {
          name
          url
          currencyCode
        }
      }
    `),
  ]);

  const productsJson = await productsResp.json();
  const shopJson = await shopResp.json();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const products: SchemaProduct[] =
    productsJson.data?.products?.edges?.map((e: any) => e.node) ?? [];

  const shop: ShopInfo = shopJson.data?.shop ?? {
    name: session.shop,
    url: `https://${session.shop}`,
    currencyCode: "USD",
  };

  const productIds = products.map((p) => p.id);
  const seoRecords = await prisma.productSeoData.findMany({
    where: { shop: session.shop, productId: { in: productIds } },
  });

  const schemaMap: Record<
    string,
    { generatedSchema: string | null; schemaApplied: boolean }
  > = {};
  for (const r of seoRecords) {
    schemaMap[r.productId] = {
      generatedSchema: r.generatedSchema,
      schemaApplied: r.schemaApplied,
    };
  }

  return { products, shop, schemaMap };
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
    const shopJson = formData.get("shopJson") as string;
    const products: SchemaProduct[] = JSON.parse(productsJson).filter(
      (p: SchemaProduct) => productIds.has(p.id),
    );
    const shop: ShopInfo = JSON.parse(shopJson);

    const generated: GeneratedSchemaItem[] = products.map((product) => ({
      productId: product.id,
      title: product.title,
      jsonLd: generateJsonLd(product, shop),
    }));

    for (const item of generated) {
      await prisma.productSeoData.upsert({
        where: {
          shop_productId: { shop: session.shop, productId: item.productId },
        },
        create: {
          shop: session.shop,
          productId: item.productId,
          generatedSchema: item.jsonLd,
          schemaApplied: false,
        },
        update: {
          generatedSchema: item.jsonLd,
          schemaApplied: false,
        },
      });
    }

    return { intent: "generate", generated };
  }

  // ── Apply ──
  if (intent === "apply") {
    const itemsJson = formData.get("itemsJson") as string;
    const items: GeneratedSchemaItem[] = JSON.parse(itemsJson);

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
                metafields(first: 5) {
                  edges {
                    node {
                      namespace
                      key
                      value
                    }
                  }
                }
              }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              input: {
                id: item.productId,
                metafields: [
                  {
                    namespace: "metaforge_seo",
                    key: "json_ld",
                    value: item.jsonLd,
                    type: "json",
                  },
                ],
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
          await prisma.productSeoData.upsert({
            where: {
              shop_productId: { shop: session.shop, productId: item.productId },
            },
            create: {
              shop: session.shop,
              productId: item.productId,
              generatedSchema: item.jsonLd,
              schemaApplied: true,
            },
            update: { schemaApplied: true },
          });
        }

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
// IndeterminateCheckbox
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
// Rich Snippet Mockup
// ---------------------------------------------------------------------------

function RichSnippetMockup({
  schema,
  shopUrl,
  handle,
}: {
  schema: Record<string, unknown>;
  shopUrl: string;
  handle: string;
}) {
  const offers = schema.offers as Record<string, unknown> | undefined;
  const isAggregate = offers?.["@type"] === "AggregateOffer";
  const currency = (offers?.priceCurrency as string) ?? "USD";
  const price = isAggregate
    ? `${currency} ${offers?.lowPrice} – ${currency} ${offers?.highPrice}`
    : `${currency} ${offers?.price ?? "—"}`;
  const inStock =
    (offers?.availability as string)?.includes("InStock") ?? false;
  const displayUrl = `${shopUrl}/products/${handle}`.replace(/^https?:\/\//, "");

  return (
    <div
      style={{
        border: "1px solid #dfe1e5",
        borderRadius: 8,
        padding: "16px 20px",
        maxWidth: 600,
        fontFamily: "arial, sans-serif",
        background: "white",
      }}
    >
      <div style={{ fontSize: 12, color: "#202124", marginBottom: 2 }}>
        <span style={{ color: "#1a0dab", fontWeight: 500 }}>
          {(schema.brand as Record<string, string>)?.name ?? ""}
        </span>
      </div>
      <div style={{ fontSize: 12, color: "#006621", marginBottom: 6 }}>
        {displayUrl.length > 80 ? displayUrl.slice(0, 80) + "…" : displayUrl}
      </div>
      <div
        style={{
          fontSize: 20,
          color: "#1a0dab",
          marginBottom: 4,
          lineHeight: 1.3,
        }}
      >
        {schema.name as string}
      </div>
      {schema.description && (
        <div
          style={{
            fontSize: 14,
            color: "#3c4043",
            marginBottom: 8,
            lineHeight: 1.5,
          }}
        >
          {(schema.description as string).slice(0, 150)}
          {(schema.description as string).length > 150 ? "…" : ""}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#202124" }}>
          {price}
        </span>
        <span
          style={{
            fontSize: 12,
            padding: "2px 8px",
            borderRadius: 12,
            background: inStock ? "#e6f4ea" : "#fce8e6",
            color: inStock ? "#137333" : "#c5221f",
            fontWeight: 500,
          }}
        >
          {inStock ? "In Stock" : "Out of Stock"}
        </span>
        {offers && (
          <span style={{ fontSize: 12, color: "#70757a" }}>
            {isAggregate
              ? `${offers.offerCount} variants`
              : "Single variant"}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Constants
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

export default function SchemaMarkup() {
  const { products, shop, schemaMap } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewProductId, setPreviewProductId] = useState<string | null>(null);

  const isGenerating =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "generate";
  const isApplying =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "apply";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetcherData = fetcher.data as any;
  const freshItems: GeneratedSchemaItem[] | null =
    fetcherData?.intent === "generate" ? fetcherData.generated : null;

  const freshMap: Record<string, string> = {};
  if (freshItems) {
    for (const item of freshItems) freshMap[item.productId] = item.jsonLd;
  }

  const applyResult =
    fetcherData?.intent === "apply"
      ? {
          applied: fetcherData.applied as number,
          errors: fetcherData.errors as { title: string; message: string }[],
        }
      : null;

  function getSchema(productId: string): string | null {
    return freshMap[productId] ?? schemaMap[productId]?.generatedSchema ?? null;
  }

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

  function handleGenerate(ids?: string[]) {
    const fd = new FormData();
    fd.set("intent", "generate");
    fd.set("productsJson", JSON.stringify(products));
    fd.set("shopJson", JSON.stringify(shop));
    const targets = ids ?? Array.from(selected);
    targets.forEach((id) => fd.append("productId", id));
    fetcher.submit(fd, { method: "post" });
  }

  function handleApply(items?: GeneratedSchemaItem[]) {
    const targets =
      items ??
      products
        .filter((p) => getSchema(p.id) !== null)
        .map((p) => ({ productId: p.id, title: p.title, jsonLd: getSchema(p.id)! }));

    const fd = new FormData();
    fd.set("intent", "apply");
    fd.set("itemsJson", JSON.stringify(targets));
    fetcher.submit(fd, { method: "post" });
  }

  // Products that have a schema (fresh or stored) and are selected
  const selectedWithSchema = Array.from(selected)
    .filter((id) => getSchema(id) !== null)
    .map((id) => {
      const product = products.find((p) => p.id === id)!;
      return { productId: id, title: product.title, jsonLd: getSchema(id)! };
    });

  const previewProduct = previewProductId
    ? products.find((p) => p.id === previewProductId) ?? null
    : null;
  const previewSchema = previewProductId ? getSchema(previewProductId) : null;

  let parsedPreview: Record<string, unknown> | null = null;
  if (previewSchema) {
    try {
      parsedPreview = JSON.parse(previewSchema);
    } catch {
      // ignore parse error
    }
  }

  return (
    <s-page heading="Schema Markup">

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
                ✓ Applied JSON-LD schema to {applyResult.applied} product
                {applyResult.applied !== 1 ? "s" : ""} successfully. Metafield{" "}
                <code>metaforge_seo.json_ld</code> is now set on each product.
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

      {/* ── JSON-LD preview panel ── */}
      {previewProduct && previewSchema && (
        <s-section heading={`JSON-LD Preview — ${previewProduct.title}`}>
          <div style={CARD_STYLE}>
            <s-stack direction="block" gap="base">

              {/* Metadata row */}
              <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <span
                  style={{
                    padding: "3px 10px",
                    borderRadius: 12,
                    background: "#e3f4f4",
                    color: "#0d4f4f",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  schema.org/Product
                </span>
                <span style={{ fontSize: 13, color: "#6d7175" }}>
                  {previewSchema.length.toLocaleString()} chars
                </span>
                <a
                  href="https://search.google.com/test/rich-results"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 13, color: "#2c6ecb", textDecoration: "underline" }}
                >
                  Validate with Google Rich Results Test ↗
                </a>
                <button
                  onClick={() => setPreviewProductId(null)}
                  style={{
                    marginLeft: "auto",
                    fontSize: 12,
                    padding: "4px 10px",
                    border: "1px solid #c9cccf",
                    borderRadius: 4,
                    background: "white",
                    cursor: "pointer",
                    color: "#3d4044",
                  }}
                >
                  Close
                </button>
              </div>

              {/* Rich snippet mockup */}
              {parsedPreview && (
                <div>
                  <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 8, fontWeight: 500 }}>
                    GOOGLE RICH SNIPPET PREVIEW
                  </div>
                  <RichSnippetMockup
                    schema={parsedPreview}
                    shopUrl={shop.url}
                    handle={previewProduct.handle}
                  />
                </div>
              )}

              {/* Raw JSON-LD */}
              <div>
                <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 8, fontWeight: 500 }}>
                  JSON-LD (copy and paste into Google&apos;s Rich Results Test)
                </div>
                <pre
                  style={{
                    background: "#f6f6f7",
                    border: "1px solid #e1e3e5",
                    borderRadius: 6,
                    padding: "12px 14px",
                    fontSize: 12,
                    lineHeight: 1.5,
                    overflow: "auto",
                    maxHeight: 400,
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {`<script type="application/ld+json">\n${previewSchema}\n</script>`}
                </pre>
              </div>

            </s-stack>
          </div>
        </s-section>
      )}

      {/* ── Product list ── */}
      <s-section heading={`Products (${products.length})`}>

        {/* Controls bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
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
            onClick={() => handleGenerate()}
          >
            {isGenerating ? "Generating…" : `Generate Schema (${selected.size})`}
          </s-button>

          {selectedWithSchema.length > 0 && (
            <s-button
              onClick={() => handleApply(selectedWithSchema)}
            >
              {isApplying
                ? "Applying…"
                : `Apply to Shopify (${selectedWithSchema.length})`}
            </s-button>
          )}
        </div>

        {/* Table */}
        <div style={{ border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden" }}>
          {/* Header */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "40px 56px 1fr 110px 90px 200px",
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
            <span>Schema</span>
            <span>Type</span>
            <span>Actions</span>
          </div>

          {/* Rows */}
          {products.map((product, idx) => {
            const storedEntry = schemaMap[product.id];
            const hasSchema = getSchema(product.id) !== null;
            const isApplied =
              freshMap[product.id] != null
                ? false // just generated, not applied yet
                : (storedEntry?.schemaApplied ?? false);
            const isThisPreviewing = previewProductId === product.id;
            const productSchema = getSchema(product.id);

            return (
              <div
                key={product.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "40px 56px 1fr 110px 90px 200px",
                  gap: 12,
                  padding: "10px 16px",
                  borderBottom: idx < products.length - 1 ? "1px solid #e1e3e5" : "none",
                  alignItems: "center",
                  background: selected.has(product.id)
                    ? "#f0f7ff"
                    : isApplied
                    ? "#f0fff4"
                    : "white",
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

                {/* Has Schema badge */}
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "3px 8px",
                    borderRadius: 12,
                    background: isApplied
                      ? "#d4edda"
                      : hasSchema
                      ? "#fff3cd"
                      : "#f6f6f7",
                    color: isApplied
                      ? "#155724"
                      : hasSchema
                      ? "#856404"
                      : "#8c9196",
                    fontSize: 12,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {isApplied ? "✓ Applied" : hasSchema ? "Generated" : "None"}
                </span>

                {/* Schema Type */}
                <span style={{ fontSize: 12, color: "#6d7175" }}>
                  {hasSchema ? "Product" : "—"}
                </span>

                {/* Action buttons */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    onClick={() => handleGenerate([product.id])}
                    style={{
                      fontSize: 12,
                      padding: "4px 10px",
                      border: "1px solid #c9cccf",
                      borderRadius: 4,
                      background: "white",
                      cursor: "pointer",
                      color: "#3d4044",
                    }}
                  >
                    Generate
                  </button>

                  <button
                    disabled={!hasSchema}
                    onClick={() =>
                      setPreviewProductId(isThisPreviewing ? null : product.id)
                    }
                    style={{
                      fontSize: 12,
                      padding: "4px 10px",
                      border: `1px solid ${isThisPreviewing ? "#2c6ecb" : "#c9cccf"}`,
                      borderRadius: 4,
                      background: isThisPreviewing ? "#f0f7ff" : "white",
                      cursor: hasSchema ? "pointer" : "not-allowed",
                      color: hasSchema ? "#2c6ecb" : "#c9cccf",
                    }}
                  >
                    Preview
                  </button>

                  <button
                    disabled={!hasSchema}
                    onClick={() => {
                      if (!productSchema) return;
                      handleApply([
                        { productId: product.id, title: product.title, jsonLd: productSchema },
                      ]);
                    }}
                    style={{
                      fontSize: 12,
                      padding: "4px 10px",
                      border: "1px solid #c9cccf",
                      borderRadius: 4,
                      background: "white",
                      cursor: hasSchema ? "pointer" : "not-allowed",
                      color: hasSchema ? "#008060" : "#c9cccf",
                    }}
                  >
                    Apply
                  </button>
                </div>
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
