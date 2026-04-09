import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { encrypt, decrypt } from "../utils/encryption.server";
import Anthropic from "@anthropic-ai/sdk";
import { useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TemplateRule {
  productType: string;
  titleTemplate: string;
  descTemplate: string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const gscStatus = url.searchParams.get("gsc");
  const gscMessage = url.searchParams.get("message");

  const settings = await prisma.appSettings.findUnique({
    where: { shop: session.shop },
  });

  const automationRules = await prisma.automationRule.findMany({
    where: { shop: session.shop },
  });

  const gscAccount = await prisma.gscAccount.findUnique({
    where: { shop: session.shop },
  });

  let templateRules: TemplateRule[] = [];
  try {
    if (settings?.templateRules) templateRules = JSON.parse(settings.templateRules);
  } catch { /* ignore */ }

  return {
    hasApiKey: !!(settings?.aiApiKey),
    aiModel: settings?.aiModel ?? "claude-sonnet-4-6",
    metaTitleTemplate: settings?.metaTitleTemplate ?? "",
    metaDescTemplate: settings?.metaDescTemplate ?? "",
    templateRules,
    automation: {
      productCreateMeta: automationRules.find((r) => r.ruleType === "product_create_meta")?.enabled ?? false,
      productCreateSchema: automationRules.find((r) => r.ruleType === "product_create_schema")?.enabled ?? false,
      weeklyMeta: automationRules.find((r) => r.ruleType === "weekly_meta")?.enabled ?? false,
      weeklySchema: automationRules.find((r) => r.ruleType === "weekly_schema")?.enabled ?? false,
      autoApply: automationRules.find((r) => r.ruleType === "product_create_meta")?.autoApply ?? false,
    },
    gscConnected: !!gscAccount,
    gscConnectedAt: gscAccount?.updatedAt ?? null,
    gscScope: gscAccount?.scope ?? null,
    gscTokenType: gscAccount?.tokenType ?? null,
    gscExpiresAt: gscAccount?.expiresAt ?? null,
    gscStatus,
    gscMessage,
  };
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // ── Save settings ──
  if (intent === "save") {
    const apiKey = (formData.get("apiKey") as string).trim();
    const aiModel = (formData.get("aiModel") as string).trim();
    const metaTitleTemplate = (formData.get("metaTitleTemplate") as string).trim();
    const metaDescTemplate = (formData.get("metaDescTemplate") as string).trim();
    const templateRulesJson = (formData.get("templateRulesJson") as string) || "[]";

    let parsedRules: TemplateRule[] = [];
    try {
      parsedRules = JSON.parse(templateRulesJson);
    } catch {
      return { intent: "save", error: "Invalid template rules data." };
    }

    try {
      const updateData: {
        aiModel: string;
        metaTitleTemplate: string;
        metaDescTemplate: string;
        templateRules: string;
        aiApiKey?: string;
      } = {
        aiModel,
        metaTitleTemplate,
        metaDescTemplate,
        templateRules: JSON.stringify(parsedRules),
      };
      if (apiKey) updateData.aiApiKey = encrypt(apiKey);

      await prisma.appSettings.upsert({
        where: { shop: session.shop },
        create: {
          shop: session.shop,
          aiApiKey: apiKey ? encrypt(apiKey) : null,
          aiModel,
          metaTitleTemplate,
          metaDescTemplate,
          templateRules: JSON.stringify(parsedRules),
        },
        update: updateData,
      });

      return { intent: "save", success: true };
    } catch (e) {
      return { intent: "save", error: String(e) };
    }
  }

  // ── Test connection ──
  if (intent === "test") {
    const submittedKey = (formData.get("apiKey") as string).trim();

    let testKey: string;
    if (submittedKey) {
      testKey = submittedKey;
    } else {
      const settings = await prisma.appSettings.findUnique({
        where: { shop: session.shop },
      });
      if (!settings?.aiApiKey) {
        return { intent: "test", error: "No API key saved. Enter your key above to test it." };
      }
      try {
        testKey = decrypt(settings.aiApiKey);
      } catch (e) {
        return { intent: "test", error: `Decryption failed: ${String(e)}` };
      }
    }

    try {
      const client = new Anthropic({ apiKey: testKey });
      await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 5,
        messages: [{ role: "user", content: "Hi" }],
      });
      return { intent: "test", success: true };
    } catch (e) {
      return { intent: "test", error: `Connection failed: ${String(e)}` };
    }
  }

  // ── Save automation rules ──
  if (intent === "saveAutomation") {
    const productCreateMeta = formData.get("productCreateMeta") === "on";
    const productCreateSchema = formData.get("productCreateSchema") === "on";
    const weeklyMeta = formData.get("weeklyMeta") === "on";
    const weeklySchema = formData.get("weeklySchema") === "on";
    const autoApply = formData.get("autoApply") === "on";

    const rules = [
      { ruleType: "product_create_meta", enabled: productCreateMeta },
      { ruleType: "product_create_schema", enabled: productCreateSchema },
      { ruleType: "weekly_meta", enabled: weeklyMeta },
      { ruleType: "weekly_schema", enabled: weeklySchema },
    ];

    try {
      for (const r of rules) {
        await prisma.automationRule.upsert({
          where: { shop_ruleType: { shop: session.shop, ruleType: r.ruleType } },
          create: { shop: session.shop, ruleType: r.ruleType, enabled: r.enabled, autoApply },
          update: { enabled: r.enabled, autoApply },
        });
      }
      return { intent: "saveAutomation", success: true };
    } catch (e) {
      return { intent: "saveAutomation", error: String(e) };
    }
  }

  // ── Run automation now (manual) ──
  if (intent === "runAutomationNow") {
    const { admin } = await authenticate.admin(request);
    const autoApply = formData.get("autoApply") === "on";
    const runMeta = formData.get("runMeta") === "on";
    const runSchema = formData.get("runSchema") === "on";

    const [productsResp, shopResp] = await Promise.all([
      admin.graphql(`#graphql
        {
          products(first: 50) {
            edges {
              node {
                id
                title
                description
                productType
                vendor
                tags
                handle
                seo { title description }
                featuredImage { url }
                images(first: 10) { edges { node { url } } }
                options { name values }
                variants(first: 100) {
                  edges { node { price sku barcode availableForSale } }
                }
              }
            }
          }
        }
      `),
      admin.graphql(`#graphql { shop { name url currencyCode } }`),
    ]);

    const pJson = await productsResp.json();
    const sJson = await shopResp.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const products = pJson.data?.products?.edges?.map((e: any) => e.node) ?? [];
    const shopInfo = sJson.data?.shop ?? { name: session.shop, url: `https://${session.shop}`, currencyCode: "USD" };

    const settings = await prisma.appSettings.findUnique({ where: { shop: session.shop } });
    const templateRules = settings?.templateRules
      ? (() => { try { return JSON.parse(settings.templateRules); } catch { return []; } })()
      : [];

    const { generateMetaForProduct, generateJsonLd } = await import("../utils/seo-automation.server");

    let queued = 0;
    const PRODUCT_UPDATE_META = `#graphql
      mutation productUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id }
          userErrors { field message }
        }
      }`;
    const PRODUCT_UPDATE_SCHEMA = `#graphql
      mutation productUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id }
          userErrors { field message }
        }
      }`;

    for (const p of products) {
      if (runMeta && (!p.seo?.title || !p.seo?.description)) {
        const meta = generateMetaForProduct(
          p,
          shopInfo,
          settings?.metaTitleTemplate ?? "{title} - {type} | {vendor}",
          settings?.metaDescTemplate ?? "",
          templateRules,
        );
        if (autoApply) {
          const resp = await admin.graphql(PRODUCT_UPDATE_META, {
            variables: { input: { id: p.id, seo: { title: meta.metaTitle, description: meta.metaDescription } } },
          });
          const json = await resp.json();
          const userErrors = json.data?.productUpdate?.userErrors ?? [];
          if (userErrors.length === 0) {
            await prisma.productSeoData.upsert({
              where: { shop_productId: { shop: session.shop, productId: p.id } },
              create: {
                shop: session.shop,
                productId: p.id,
                generatedMeta: JSON.stringify(meta),
                applied: true,
              },
              update: {
                generatedMeta: JSON.stringify(meta),
                applied: true,
              },
            });
            await prisma.seoChangeQueue.create({
              data: {
                shop: session.shop,
                productId: p.id,
                productTitle: p.title,
                changeType: "meta",
                payload: JSON.stringify(meta),
                status: "applied",
                appliedAt: new Date(),
              },
            });
            queued++;
          } else {
            await prisma.seoChangeQueue.create({
              data: {
                shop: session.shop,
                productId: p.id,
                productTitle: p.title,
                changeType: "meta",
                payload: JSON.stringify(meta),
                status: "failed",
                error: userErrors.map((e: any) => e.message).join(", "),
              },
            });
          }
        } else {
          await prisma.seoChangeQueue.create({
            data: {
              shop: session.shop,
              productId: p.id,
              productTitle: p.title,
              changeType: "meta",
              payload: JSON.stringify(meta),
            },
          });
          queued++;
        }
      }
      if (runSchema) {
        const jsonLd = generateJsonLd(p, shopInfo);
        if (autoApply) {
          const resp = await admin.graphql(PRODUCT_UPDATE_SCHEMA, {
            variables: {
              input: {
                id: p.id,
                metafields: [{ namespace: "metaforge_seo", key: "json_ld", value: jsonLd, type: "json" }],
              },
            },
          });
          const json = await resp.json();
          const userErrors = json.data?.productUpdate?.userErrors ?? [];
          if (userErrors.length === 0) {
            await prisma.productSeoData.upsert({
              where: { shop_productId: { shop: session.shop, productId: p.id } },
              create: {
                shop: session.shop,
                productId: p.id,
                generatedSchema: jsonLd,
                schemaApplied: true,
              },
              update: {
                generatedSchema: jsonLd,
                schemaApplied: true,
              },
            });
            await prisma.seoChangeQueue.create({
              data: {
                shop: session.shop,
                productId: p.id,
                productTitle: p.title,
                changeType: "schema",
                payload: JSON.stringify({ jsonLd }),
                status: "applied",
                appliedAt: new Date(),
              },
            });
            queued++;
          } else {
            await prisma.seoChangeQueue.create({
              data: {
                shop: session.shop,
                productId: p.id,
                productTitle: p.title,
                changeType: "schema",
                payload: JSON.stringify({ jsonLd }),
                status: "failed",
                error: userErrors.map((e: any) => e.message).join(", "),
              },
            });
          }
        } else {
          await prisma.seoChangeQueue.create({
            data: {
              shop: session.shop,
              productId: p.id,
              productTitle: p.title,
              changeType: "schema",
              payload: JSON.stringify({ jsonLd }),
            },
          });
          queued++;
        }
      }
    }

    return { intent: "runAutomationNow", queued };
  }

  // ── Disconnect GSC ──
  if (intent === "gscDisconnect") {
    try {
      await prisma.gscAccount.delete({ where: { shop: session.shop } });
      return { intent: "gscDisconnect", success: true };
    } catch (e) {
      return { intent: "gscDisconnect", error: String(e) };
    }
  }

  return { error: "Unknown intent" };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CARD_STYLE: React.CSSProperties = {
  background: "white",
  border: "1px solid #e1e3e5",
  borderRadius: 8,
  padding: "16px",
};

const MODELS = [
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 — Fast & affordable" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — Recommended (best balance)" },
  { value: "claude-opus-4-6", label: "Claude Opus 4.6 — Highest quality" },
];

// ---------------------------------------------------------------------------
// SERP preview helpers
// ---------------------------------------------------------------------------

/** Substitute sample product values into a template for live preview. */
function previewTemplate(template: string, productTypeOverride?: string): string {
  if (!template) return "";
  const year = new Date().getFullYear().toString();
  return template
    .replace(/{title}/g, "Industrial Drill Press")
    .replace(/{vendor}/g, "DeWalt")
    .replace(/{type}/g, productTypeOverride || "Power Tools")
    .replace(/{store}/g, "Your Store")
    .replace(/{price}/g, "$349.99")
    .replace(/{price_min}/g, "$299.99")
    .replace(/{price_max}/g, "$499.99")
    .replace(/{sku}/g, "DWP611PK")
    .replace(/{barcode}/g, "00012345")
    .replace(/{option1}/g, "Large")
    .replace(/{option2}/g, "")
    .replace(/{option3}/g, "")
    .replace(/{availability}/g, "In Stock")
    .replace(/{first_tag}/g, "professional")
    .replace(/{year}/g, year)
    .replace(/{description_short}/g, "Heavy-duty 15\u2033 drill press with laser guide")
    .replace(/{description}/g, "Heavy-duty 15\u2033 drill press with laser guide and depth stop")
    .replace(/{variant_count}/g, "3")
    .replace(/\s*[-|]\s*[-|]\s*/g, " | ")
    .replace(/^\s*[-|]\s*/, "")
    .replace(/\s*[-|]\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

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
        maxWidth: 600,
        padding: "14px 16px",
        background: "#fff",
        border: "1px solid #dfe1e5",
        borderRadius: 8,
      }}
    >
      {/* Breadcrumb row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#e8eaed",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 13,
            color: "#202124",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {url}
        </span>
      </div>
      {/* Title */}
      <div
        style={{
          fontSize: 20,
          lineHeight: "1.3",
          color: title ? "#1558d6" : "#9aa0a6",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          marginBottom: 4,
          fontWeight: 400,
        }}
      >
        {title || "Your meta title will appear here"}
      </div>
      {/* Description */}
      <div
        style={{
          fontSize: 14,
          color: description ? "#4d5156" : "#9aa0a6",
          lineHeight: "1.58",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical" as const,
          overflow: "hidden",
        }}
      >
        {description || "Your meta description will appear here."}
      </div>
    </div>
  );
}

const LIQUID_SNIPPET = `{% if product.metafields.metaforge_seo.json_ld %}
  <script type="application/ld+json">
    {{ product.metafields.metaforge_seo.json_ld }}
  </script>
{% endif %}`;

const DEFAULT_TITLE_TEMPLATE = "{title} - {type} | {vendor}";

const TITLE_PRESETS = [
  { label: "Default", value: "{title} - {type} | {vendor}" },
  { label: "Brand + Year", value: "{title} | {vendor} {year}" },
  { label: "Buy intent", value: "Buy {title} by {vendor} | {store}" },
  { label: "Price range", value: "{title} — From {price_min} | {vendor}" },
  { label: "SKU-first (B2B)", value: "{title} — SKU {sku} | {vendor}" },
  { label: "Availability", value: "{title} — {availability} | {vendor}" },
  { label: "Stock + type", value: "{title} | {type} — {availability}" },
];

const DESC_PRESETS = [
  { label: "Product description", value: "{description}" },
  { label: "Short desc + vendor", value: "{description_short} — Shop {vendor} at {store}." },
  { label: "Availability + desc", value: "{availability}: {description_short}" },
  { label: "Price + desc", value: "From {price_min}. {description_short}" },
];

const TOKEN_REFERENCE: { token: string; description: string }[] = [
  { token: "{title}", description: "Product title" },
  { token: "{vendor}", description: "Brand / vendor name" },
  { token: "{type}", description: "Product type / category" },
  { token: "{store}", description: "Store name" },
  { token: "{price}", description: "Starting price (e.g. $49.99)" },
  { token: "{price_min}", description: "Lowest variant price" },
  { token: "{price_max}", description: "Highest variant price" },
  { token: "{sku}", description: "First variant SKU" },
  { token: "{barcode}", description: "First variant barcode" },
  { token: "{option1}", description: "First variant option (e.g. Size value)" },
  { token: "{option2}", description: "Second variant option (e.g. Color value)" },
  { token: "{option3}", description: "Third variant option" },
  { token: "{availability}", description: '"In Stock" or "Out of Stock"' },
  { token: "{first_tag}", description: "First product tag" },
  { token: "{year}", description: "Current year (e.g. 2026)" },
  { token: "{description_short}", description: "First 100 chars of stripped description" },
  { token: "{description}", description: "Full stripped description" },
  { token: "{variant_count}", description: "Number of variants" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Settings() {
  const {
    hasApiKey,
    aiModel: savedModel,
    metaTitleTemplate: savedTitleTemplate,
    metaDescTemplate: savedDescTemplate,
    templateRules: savedRules,
    automation,
    gscConnected,
    gscConnectedAt,
    gscScope,
    gscTokenType,
    gscExpiresAt,
    gscStatus,
    gscMessage,
  } = useLoaderData<typeof loader>();

  const fetcher = useFetcher<typeof action>();
  const automationFetcher = useFetcher<typeof action>();
  const runFetcher = useFetcher<typeof action>();

  const [apiKey, setApiKey] = useState("");
  const [aiModel, setAiModel] = useState(savedModel);
  const [metaTitleTemplate, setMetaTitleTemplate] = useState(savedTitleTemplate);
  const [metaDescTemplate, setMetaDescTemplate] = useState(savedDescTemplate);
  const [rules, setRules] = useState<TemplateRule[]>(savedRules);
  const [copied, setCopied] = useState(false);

  const isSaving = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "save";
  const isTesting = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "test";
  const isDisconnecting =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "gscDisconnect";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = fetcher.data as any;
  const saveResult = data?.intent === "save" ? data : null;
  const testResult = data?.intent === "test" ? data : null;
  const gscResult = data?.intent === "gscDisconnect" ? data : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const automationData = automationFetcher.data as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runData = runFetcher.data as any;
  const automationResult = automationData?.intent === "saveAutomation" ? automationData : null;
  const runResult = runData?.intent === "runAutomationNow" ? runData : null;

  function handleSave() {
    const fd = new FormData();
    fd.set("intent", "save");
    fd.set("apiKey", apiKey);
    fd.set("aiModel", aiModel);
    fd.set("metaTitleTemplate", metaTitleTemplate);
    fd.set("metaDescTemplate", metaDescTemplate);
    fd.set("templateRulesJson", JSON.stringify(rules));
    fetcher.submit(fd, { method: "post" });
  }

  function handleTest() {
    const fd = new FormData();
    fd.set("intent", "test");
    fd.set("apiKey", apiKey);
    fetcher.submit(fd, { method: "post" });
  }

  function handleGscDisconnect() {
    const fd = new FormData();
    fd.set("intent", "gscDisconnect");
    fetcher.submit(fd, { method: "post" });
  }

  function handleCopy() {
    navigator.clipboard.writeText(LIQUID_SNIPPET).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function addRule() {
    setRules((prev) => [...prev, { productType: "", titleTemplate: "", descTemplate: "" }]);
  }

  function removeRule(idx: number) {
    setRules((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateRule(idx: number, field: keyof TemplateRule, value: string) {
    setRules((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)),
    );
  }

  const inputStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    padding: "8px 10px",
    border: "1px solid #c9cccf",
    borderRadius: 4,
    fontSize: 14,
    boxSizing: "border-box",
  };

  const monoInputStyle: React.CSSProperties = {
    ...inputStyle,
    fontFamily: "monospace",
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 6,
  };

  return (
    <s-page heading="Settings">

      {/* ── Status banners ── */}
      {(saveResult || testResult) && (
        <s-section>
          {saveResult && (
            <div
              style={{
                padding: "10px 14px",
                background: saveResult.success ? "#d4edda" : "#f8d7da",
                color: saveResult.success ? "#155724" : "#721c24",
                borderRadius: 6,
                fontSize: 14,
              }}
            >
              {saveResult.success ? "✓ Settings saved." : `✗ ${saveResult.error}`}
            </div>
          )}
          {testResult && (
            <div
              style={{
                padding: "10px 14px",
                background: testResult.success ? "#d4edda" : "#f8d7da",
                color: testResult.success ? "#155724" : "#721c24",
                borderRadius: 6,
                fontSize: 14,
              }}
            >
              {testResult.success
                ? "✓ Connection successful! Your API key is valid."
                : `✗ ${testResult.error}`}
            </div>
          )}
        </s-section>
      )}

      {/* ── AI Configuration ── */}
      <s-section heading="AI Configuration">
        <s-stack direction="block" gap="base">

          {hasApiKey && (
            <div style={{ padding: "10px 14px", background: "#d4edda", color: "#155724", borderRadius: 6, fontSize: 14 }}>
              ✓ Anthropic API key is saved. Enter a new key below to replace it.
            </div>
          )}

          <div style={CARD_STYLE}>
            <s-stack direction="block" gap="base">

              <div>
                <label style={labelStyle}>Anthropic API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={hasApiKey ? "Enter new key to replace existing..." : "sk-ant-api03-..."}
                  style={monoInputStyle}
                />
                <p style={{ fontSize: 12, color: "#6d7175", marginTop: 4, marginBottom: 0 }}>
                  Get your key at console.anthropic.com. Keys are encrypted at rest with AES-256-GCM.
                </p>
              </div>

              <div>
                <label style={labelStyle}>AI Model</label>
                <select
                  value={aiModel}
                  onChange={(e) => setAiModel(e.target.value)}
                  style={{ padding: "8px 10px", border: "1px solid #c9cccf", borderRadius: 4, fontSize: 14, background: "white", minWidth: 340 }}
                >
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <s-button variant="primary" onClick={handleSave}>
                  {isSaving ? "Saving…" : "Save Settings"}
                </s-button>
                <s-button onClick={handleTest}>
                  {isTesting ? "Testing…" : "Test Connection"}
                </s-button>
              </div>

            </s-stack>
          </div>

          <div style={{ ...CARD_STYLE, background: "#f6f6f7", borderColor: "#c9cccf" }}>
            <p style={{ fontSize: 13, fontWeight: 600, marginTop: 0, marginBottom: 8 }}>
              Required: ENCRYPTION_KEY environment variable
            </p>
            <p style={{ fontSize: 13, color: "#3d4044", marginTop: 0, marginBottom: 8 }}>
              API keys are encrypted at rest. Add <code>ENCRYPTION_KEY</code> to your <code>.env</code> file:
            </p>
            <pre style={{ background: "#1d1d1d", color: "#e6e6e6", padding: "10px 14px", borderRadius: 6, fontSize: 12, overflow: "auto", margin: "0 0 8px" }}>
              {"node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""}
            </pre>
            <p style={{ fontSize: 13, color: "#3d4044", margin: 0 }}>
              Then add to <code>.env</code>: <code style={{ userSelect: "all" }}>ENCRYPTION_KEY=your_64_char_hex_value</code>
            </p>
          </div>

        </s-stack>
      </s-section>

      {/* ── Automation ── */}
      <s-section heading="Automation">
        <s-stack direction="block" gap="base">
          {automationResult && (
            <div
              style={{
                padding: "10px 14px",
                background: automationResult.success ? "#d4edda" : "#f8d7da",
                color: automationResult.success ? "#155724" : "#721c24",
                borderRadius: 6,
                fontSize: 14,
              }}
            >
              {automationResult.success ? "✓ Automation settings saved." : `✗ ${automationResult.error}`}
            </div>
          )}
          {runResult && (
            <div
              style={{
                padding: "10px 14px",
                background: "#d4edda",
                color: "#155724",
                borderRadius: 6,
                fontSize: 14,
              }}
            >
              ✓ Queued {runResult.queued} change{runResult.queued !== 1 ? "s" : ""}.
            </div>
          )}

          <div style={CARD_STYLE}>
            <s-stack direction="block" gap="base">
              <automationFetcher.Form method="post">
                <input type="hidden" name="intent" value="saveAutomation" />
                <s-stack direction="block" gap="base">
                  <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input type="checkbox" name="productCreateMeta" defaultChecked={automation.productCreateMeta} />
                    <span>Auto-generate meta tags when a product is created</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input type="checkbox" name="productCreateSchema" defaultChecked={automation.productCreateSchema} />
                    <span>Auto-generate schema when a product is created</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input type="checkbox" name="weeklyMeta" defaultChecked={automation.weeklyMeta} />
                    <span>Weekly run: generate missing meta tags</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input type="checkbox" name="weeklySchema" defaultChecked={automation.weeklySchema} />
                    <span>Weekly run: generate missing schema</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input type="checkbox" name="autoApply" defaultChecked={automation.autoApply} />
                    <span>Auto-apply changes (skip approval queue)</span>
                  </label>

                  <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <s-button variant="primary" type="submit">
                      Save Automation Settings
                    </s-button>
                    <a
                      href="/app/approval-queue"
                      style={{ fontSize: 12, color: "#2c6ecb", textDecoration: "underline" }}
                    >
                      View Approval Queue →
                    </a>
                  </div>
                </s-stack>
              </automationFetcher.Form>

              <runFetcher.Form method="post">
                <input type="hidden" name="intent" value="runAutomationNow" />
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" name="runMeta" defaultChecked />
                    <span style={{ fontSize: 12 }}>Meta</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" name="runSchema" defaultChecked />
                    <span style={{ fontSize: 12 }}>Schema</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" name="autoApply" defaultChecked={automation.autoApply} />
                    <span style={{ fontSize: 12 }}>Auto-apply</span>
                  </label>
                  <s-button type="submit">Run Now</s-button>
                </div>
              </runFetcher.Form>
            </s-stack>
          </div>
        </s-stack>
      </s-section>

      {/* ── Google Search Console ── */}
      <s-section heading="Google Search Console">
        <s-stack direction="block" gap="base">

          {gscStatus === "connected" && (
            <div
              style={{
                padding: "10px 14px",
                background: "#d4edda",
                color: "#155724",
                borderRadius: 6,
                fontSize: 14,
              }}
            >
              ✓ Google Search Console connected successfully.
            </div>
          )}

          {gscStatus === "error" && (
            <div
              style={{
                padding: "10px 14px",
                background: "#f8d7da",
                color: "#721c24",
                borderRadius: 6,
                fontSize: 14,
              }}
            >
              ✗ Google Search Console connection failed.
              {gscMessage ? ` ${gscMessage}` : ""}
            </div>
          )}

          {gscResult && (
            <div
              style={{
                padding: "10px 14px",
                background: gscResult.success ? "#d4edda" : "#f8d7da",
                color: gscResult.success ? "#155724" : "#721c24",
                borderRadius: 6,
                fontSize: 14,
              }}
            >
              {gscResult.success
                ? "✓ Google Search Console disconnected."
                : `✗ ${gscResult.error}`}
            </div>
          )}

          <div style={CARD_STYLE}>
            <s-stack direction="block" gap="base">
              <p style={{ fontSize: 13, color: "#3d4044", margin: 0 }}>
                Connect Google Search Console to measure impressions, clicks, and CTR
                for your product pages.
              </p>

              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                {gscConnected ? (
                  <>
                    <span style={{ fontSize: 13, color: "#3d4044" }}>
                      Status: <strong>Connected</strong>
                    </span>
                    {gscConnectedAt && (
                      <span style={{ fontSize: 12, color: "#6d7175" }}>
                        Last updated: {new Date(gscConnectedAt).toLocaleString()}
                      </span>
                    )}
                    {gscScope && (
                      <span style={{ fontSize: 12, color: "#6d7175" }}>
                        Scope: {gscScope}
                      </span>
                    )}
                    {gscTokenType && (
                      <span style={{ fontSize: 12, color: "#6d7175" }}>
                        Token type: {gscTokenType}
                      </span>
                    )}
                    {gscExpiresAt && (
                      <span style={{ fontSize: 12, color: "#6d7175" }}>
                        Expires: {new Date(gscExpiresAt).toLocaleString()}
                      </span>
                    )}
                    <button
                      onClick={handleGscDisconnect}
                      style={{
                        padding: "6px 12px",
                        background: "#f6f6f7",
                        color: "#3d4044",
                        border: "1px solid #c9cccf",
                        borderRadius: 4,
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                      disabled={isDisconnecting}
                    >
                      {isDisconnecting ? "Disconnecting…" : "Disconnect"}
                    </button>
                  </>
                ) : (
                  <a
                    href="/app/gsc/connect"
                    target="_top"
                    rel="noreferrer"
                    style={{
                      padding: "8px 12px",
                      background: "#005bd3",
                      color: "white",
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600,
                      textDecoration: "none",
                    }}
                  >
                    Connect Google Search Console
                  </a>
                )}
              </div>
            </s-stack>
          </div>

          <div style={{ ...CARD_STYLE, background: "#f6f6f7", borderColor: "#c9cccf" }}>
            <p style={{ fontSize: 13, fontWeight: 600, marginTop: 0, marginBottom: 6 }}>
              Required environment variables
            </p>
            <div style={{ fontSize: 12, color: "#3d4044" }}>
              <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>,{" "}
              <code>GOOGLE_REDIRECT_URI</code>
            </div>
          </div>

        </s-stack>
      </s-section>

      {/* ── Token Reference ── */}
      <s-section heading="Available Template Tokens">
        <div style={CARD_STYLE}>
          <p style={{ fontSize: 13, color: "#3d4044", marginTop: 0, marginBottom: 12 }}>
            Use these tokens in any template below. Empty tokens (e.g. no SKU on a product) are removed cleanly — separators around them collapse automatically.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "160px 1fr 160px 1fr",
              gap: "5px 20px",
              fontSize: 13,
              color: "#3d4044",
            }}
          >
            {TOKEN_REFERENCE.map(({ token, description }) => (
              <>
                <code key={`t-${token}`} style={{ color: "#008060", whiteSpace: "nowrap" }}>{token}</code>
                <span key={`d-${token}`} style={{ color: "#6d7175" }}>{description}</span>
              </>
            ))}
          </div>
        </div>
      </s-section>

      {/* ── Meta Title Template ── */}
      <s-section heading="Default Meta Title Template">
        <s-stack direction="block" gap="base">

          <p style={{ fontSize: 14, color: "#3d4044", margin: 0 }}>
            Applied to all products unless a product-type rule overrides it.
          </p>

          <div style={CARD_STYLE}>
            <s-stack direction="block" gap="base">

              <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 280 }}>
                  <label style={labelStyle}>Title Template</label>
                  <input
                    type="text"
                    value={metaTitleTemplate}
                    onChange={(e) => setMetaTitleTemplate(e.target.value)}
                    placeholder={DEFAULT_TITLE_TEMPLATE}
                    style={monoInputStyle}
                  />
                  <p style={{ fontSize: 12, color: "#6d7175", marginTop: 4, marginBottom: 0 }}>
                    Default: <code>{DEFAULT_TITLE_TEMPLATE}</code> · Max 60 chars after substitution
                  </p>
                </div>
                <div>
                  <label style={labelStyle}>Presets</label>
                  <select
                    onChange={(e) => { if (e.target.value) setMetaTitleTemplate(e.target.value); e.target.value = ""; }}
                    defaultValue=""
                    style={{ padding: "8px 10px", border: "1px solid #c9cccf", borderRadius: 4, fontSize: 13, background: "white" }}
                  >
                    <option value="">Load a preset…</option>
                    {TITLE_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <p style={{ fontSize: 12, color: "#6d7175", marginTop: 0, marginBottom: 8 }}>
                  SERP preview with sample values — updates as you type:
                </p>
                <SerpPreview
                  title={previewTemplate(metaTitleTemplate || DEFAULT_TITLE_TEMPLATE).slice(0, 60)}
                  description={previewTemplate(metaDescTemplate).slice(0, 155)}
                  url="yourstore.com › products › industrial-drill-press"
                />
              </div>

            </s-stack>
          </div>

        </s-stack>
      </s-section>

      {/* ── Meta Description Template ── */}
      <s-section heading="Default Meta Description Template">
        <s-stack direction="block" gap="base">

          <p style={{ fontSize: 14, color: "#3d4044", margin: 0 }}>
            Leave blank to use the product description automatically. Applied to all products unless a product-type rule overrides it.
          </p>

          <div style={CARD_STYLE}>
            <s-stack direction="block" gap="base">

              <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 280 }}>
                  <label style={labelStyle}>Description Template</label>
                  <input
                    type="text"
                    value={metaDescTemplate}
                    onChange={(e) => setMetaDescTemplate(e.target.value)}
                    placeholder="{description}"
                    style={monoInputStyle}
                  />
                  <p style={{ fontSize: 12, color: "#6d7175", marginTop: 4, marginBottom: 0 }}>
                    Max 155 chars after substitution
                  </p>
                </div>
                <div>
                  <label style={labelStyle}>Presets</label>
                  <select
                    onChange={(e) => { if (e.target.value) setMetaDescTemplate(e.target.value); e.target.value = ""; }}
                    defaultValue=""
                    style={{ padding: "8px 10px", border: "1px solid #c9cccf", borderRadius: 4, fontSize: 13, background: "white" }}
                  >
                    <option value="">Load a preset…</option>
                    {DESC_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
              </div>

            </s-stack>
          </div>

        </s-stack>
      </s-section>

      {/* ── Template Rules by Product Type ── */}
      <s-section heading="Template Rules by Product Type">
        <s-stack direction="block" gap="base">

          <p style={{ fontSize: 14, color: "#3d4044", margin: 0 }}>
            Override the default templates for specific product types. Matched case-insensitively against the product's type in Shopify. Rules are checked in order — first match wins.
          </p>

          {rules.length === 0 && (
            <div
              style={{
                padding: "20px 16px",
                textAlign: "center",
                color: "#8c9196",
                fontSize: 14,
                border: "1px dashed #c9cccf",
                borderRadius: 8,
              }}
            >
              No rules yet. Add one to use different templates per product type.
            </div>
          )}

          {rules.map((rule, idx) => (
            <div key={idx} style={CARD_STYLE}>
              <s-stack direction="block" gap="base">

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: 14, color: "#3d4044" }}>
                    Rule {idx + 1}{rule.productType ? ` — ${rule.productType}` : ""}
                  </strong>
                  <button
                    onClick={() => removeRule(idx)}
                    style={{
                      background: "none",
                      border: "1px solid #c9cccf",
                      borderRadius: 4,
                      padding: "3px 10px",
                      fontSize: 12,
                      color: "#d82c0d",
                      cursor: "pointer",
                    }}
                  >
                    Remove
                  </button>
                </div>

                <div>
                  <label style={labelStyle}>Product Type</label>
                  <input
                    type="text"
                    value={rule.productType}
                    onChange={(e) => updateRule(idx, "productType", e.target.value)}
                    placeholder="e.g. Drill Press"
                    style={inputStyle}
                  />
                  <p style={{ fontSize: 12, color: "#6d7175", marginTop: 4, marginBottom: 0 }}>
                    Must match the product type exactly as set in Shopify (case-insensitive)
                  </p>
                </div>

                <div>
                  <label style={labelStyle}>Meta Title Template</label>
                  <input
                    type="text"
                    value={rule.titleTemplate}
                    onChange={(e) => updateRule(idx, "titleTemplate", e.target.value)}
                    placeholder={`Leave blank to use default: ${DEFAULT_TITLE_TEMPLATE}`}
                    style={monoInputStyle}
                  />
                </div>

                <div>
                  <label style={labelStyle}>Meta Description Template</label>
                  <input
                    type="text"
                    value={rule.descTemplate}
                    onChange={(e) => updateRule(idx, "descTemplate", e.target.value)}
                    placeholder="Leave blank to use default description template"
                    style={monoInputStyle}
                  />
                </div>

                {(rule.titleTemplate || rule.descTemplate) && (
                  <div>
                    <p style={{ fontSize: 12, color: "#6d7175", marginTop: 0, marginBottom: 8 }}>
                      SERP preview for this rule:
                    </p>
                    <SerpPreview
                      title={previewTemplate(
                        rule.titleTemplate || DEFAULT_TITLE_TEMPLATE,
                        rule.productType || undefined,
                      ).slice(0, 60)}
                      description={previewTemplate(
                        rule.descTemplate,
                        rule.productType || undefined,
                      ).slice(0, 155)}
                      url="yourstore.com › products › industrial-drill-press"
                    />
                  </div>
                )}

              </s-stack>
            </div>
          ))}

          <div>
            <s-button onClick={addRule}>+ Add Rule</s-button>
          </div>

          <div style={{ paddingTop: 4 }}>
            <s-button variant="primary" onClick={handleSave}>
              {isSaving ? "Saving…" : "Save All Settings"}
            </s-button>
          </div>

        </s-stack>
      </s-section>

      {/* ── Theme Integration ── */}
      <s-section heading="Theme Integration — JSON-LD Schema Markup">
        <s-stack direction="block" gap="base">

          <p style={{ fontSize: 14, color: "#3d4044", margin: 0 }}>
            After applying schema markup via the Schema Markup page, add this Liquid snippet to your
            product template (<code>sections/main-product.liquid</code>), inside the{" "}
            <code>{"<head>"}</code> or just before <code>{"</body>"}</code>:
          </p>

          <div style={CARD_STYLE}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#3d4044" }}>
                sections/main-product.liquid
              </span>
              <button
                onClick={handleCopy}
                style={{
                  padding: "4px 12px",
                  background: copied ? "#008060" : "#f6f6f7",
                  color: copied ? "white" : "#3d4044",
                  border: "1px solid #c9cccf",
                  borderRadius: 4,
                  fontSize: 12,
                  cursor: "pointer",
                  transition: "background 0.2s",
                }}
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <pre style={{ background: "#1d1d1d", color: "#e6e6e6", padding: "12px 16px", borderRadius: 6, fontSize: 13, overflow: "auto", margin: 0, lineHeight: 1.6 }}>
              {LIQUID_SNIPPET}
            </pre>
          </div>

          <p style={{ fontSize: 13, color: "#6d7175", margin: 0 }}>
            This renders the JSON-LD structured data stored in the{" "}
            <code>metaforge_seo.json_ld</code> metafield, enabling Google Rich Results for product pages.
          </p>

        </s-stack>
      </s-section>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
