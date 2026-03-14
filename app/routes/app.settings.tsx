import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { encrypt, decrypt } from "../utils/encryption.server";
import Anthropic from "@anthropic-ai/sdk";
import { useState } from "react";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const settings = await prisma.appSettings.findUnique({
    where: { shop: session.shop },
  });

  return {
    hasApiKey: !!(settings?.aiApiKey),
    aiModel: settings?.aiModel ?? "claude-sonnet-4-6",
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

    try {
      const updateData: { aiModel: string; aiApiKey?: string } = { aiModel };
      if (apiKey) {
        updateData.aiApiKey = encrypt(apiKey);
      }

      await prisma.appSettings.upsert({
        where: { shop: session.shop },
        create: {
          shop: session.shop,
          aiApiKey: apiKey ? encrypt(apiKey) : null,
          aiModel,
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
        return {
          intent: "test",
          error: "No API key saved. Enter your key above to test it.",
        };
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

  return { error: "Unknown intent" };
};

// ---------------------------------------------------------------------------
// Component
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

const LIQUID_SNIPPET = `{% if product.metafields.metaforge_seo.json_ld %}
  <script type="application/ld+json">
    {{ product.metafields.metaforge_seo.json_ld }}
  </script>
{% endif %}`;

export default function Settings() {
  const { hasApiKey, aiModel: savedModel } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [apiKey, setApiKey] = useState("");
  const [aiModel, setAiModel] = useState(savedModel);
  const [copied, setCopied] = useState(false);

  const isSaving = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "save";
  const isTesting = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "test";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = fetcher.data as any;
  const saveResult = data?.intent === "save" ? data : null;
  const testResult = data?.intent === "test" ? data : null;

  function handleSave() {
    const fd = new FormData();
    fd.set("intent", "save");
    fd.set("apiKey", apiKey);
    fd.set("aiModel", aiModel);
    fetcher.submit(fd, { method: "post" });
  }

  function handleTest() {
    const fd = new FormData();
    fd.set("intent", "test");
    fd.set("apiKey", apiKey);
    fetcher.submit(fd, { method: "post" });
  }

  function handleCopy() {
    navigator.clipboard.writeText(LIQUID_SNIPPET).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <s-page heading="Settings">

      {/* ── AI Configuration ── */}
      <s-section heading="AI Configuration">
        <s-stack direction="block" gap="base">

          {hasApiKey && (
            <div
              style={{
                padding: "10px 14px",
                background: "#d4edda",
                color: "#155724",
                borderRadius: 6,
                fontSize: 14,
              }}
            >
              ✓ Anthropic API key is saved. Enter a new key below to replace it.
            </div>
          )}

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
              {saveResult.success ? "✓ Settings saved successfully." : `✗ ${saveResult.error}`}
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

          <div style={CARD_STYLE}>
            <s-stack direction="block" gap="base">

              <div>
                <label
                  style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}
                >
                  Anthropic API Key
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    hasApiKey ? "Enter new key to replace existing..." : "sk-ant-api03-..."
                  }
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "8px 10px",
                    border: "1px solid #c9cccf",
                    borderRadius: 4,
                    fontSize: 14,
                    fontFamily: "monospace",
                    boxSizing: "border-box",
                  }}
                />
                <p style={{ fontSize: 12, color: "#6d7175", marginTop: 4, marginBottom: 0 }}>
                  Get your key at console.anthropic.com. Keys are encrypted before storage using
                  AES-256-GCM.
                </p>
              </div>

              <div>
                <label
                  style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}
                >
                  AI Model
                </label>
                <select
                  value={aiModel}
                  onChange={(e) => setAiModel(e.target.value)}
                  style={{
                    padding: "8px 10px",
                    border: "1px solid #c9cccf",
                    borderRadius: 4,
                    fontSize: 14,
                    background: "white",
                    minWidth: 340,
                  }}
                >
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
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

          {/* Encryption key setup instructions */}
          <div style={{ ...CARD_STYLE, background: "#f6f6f7", borderColor: "#c9cccf" }}>
            <p style={{ fontSize: 13, fontWeight: 600, marginTop: 0, marginBottom: 8 }}>
              Required: ENCRYPTION_KEY environment variable
            </p>
            <p style={{ fontSize: 13, color: "#3d4044", marginTop: 0, marginBottom: 8 }}>
              API keys are encrypted at rest. Add <code>ENCRYPTION_KEY</code> to your{" "}
              <code>.env</code> file. Generate a key:
            </p>
            <pre
              style={{
                background: "#1d1d1d",
                color: "#e6e6e6",
                padding: "10px 14px",
                borderRadius: 6,
                fontSize: 12,
                overflow: "auto",
                margin: "0 0 8px",
              }}
            >
              {"node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""}
            </pre>
            <p style={{ fontSize: 13, color: "#3d4044", margin: 0 }}>
              Then add to <code>.env</code>:{" "}
              <code style={{ userSelect: "all" }}>ENCRYPTION_KEY=your_64_char_hex_value</code>
            </p>
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
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
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
            <pre
              style={{
                background: "#1d1d1d",
                color: "#e6e6e6",
                padding: "12px 16px",
                borderRadius: 6,
                fontSize: 13,
                overflow: "auto",
                margin: 0,
                lineHeight: 1.6,
              }}
            >
              {LIQUID_SNIPPET}
            </pre>
          </div>

          <p style={{ fontSize: 13, color: "#6d7175", margin: 0 }}>
            This renders the JSON-LD structured data stored in the{" "}
            <code>metaforge_seo.json_ld</code> metafield, enabling Google Rich Results for product
            pages.
          </p>

        </s-stack>
      </s-section>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
