import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

type QueueItem = {
  id: string;
  productId: string;
  productTitle: string;
  changeType: "meta" | "schema";
  payload: string;
  createdAt: Date;
};

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const items = await prisma.seoChangeQueue.findMany({
    where: { shop: session.shop, status: "pending" },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return { items };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const itemId = formData.get("itemId") as string;

  if (!itemId) return { error: "Missing itemId" };

  const item = await prisma.seoChangeQueue.findUnique({ where: { id: itemId } });
  if (!item || item.shop !== session.shop) return { error: "Queue item not found" };

  if (intent === "skip") {
    await prisma.seoChangeQueue.update({
      where: { id: itemId },
      data: { status: "skipped" },
    });
    return { intent: "skip", id: itemId };
  }

  if (intent === "apply") {
    try {
      if (item.changeType === "meta") {
        const payload = JSON.parse(item.payload) as { metaTitle: string; metaDescription: string };
        const resp = await admin.graphql(PRODUCT_UPDATE_META, {
          variables: {
            input: { id: item.productId, seo: { title: payload.metaTitle, description: payload.metaDescription } },
          },
        });
        const json = await resp.json();
        const userErrors = json.data?.productUpdate?.userErrors ?? [];
        if (userErrors.length) {
          throw new Error(userErrors.map((e: any) => e.message).join(", "));
        }

        await prisma.productSeoData.upsert({
          where: { shop_productId: { shop: session.shop, productId: item.productId } },
          create: {
            shop: session.shop,
            productId: item.productId,
            generatedMeta: JSON.stringify(payload),
            applied: true,
          },
          update: {
            generatedMeta: JSON.stringify(payload),
            applied: true,
          },
        });
      } else if (item.changeType === "schema") {
        const payload = JSON.parse(item.payload) as { jsonLd: string };
        const resp = await admin.graphql(PRODUCT_UPDATE_SCHEMA, {
          variables: {
            input: {
              id: item.productId,
              metafields: [{ namespace: "metaforge_seo", key: "json_ld", value: payload.jsonLd, type: "json" }],
            },
          },
        });
        const json = await resp.json();
        const userErrors = json.data?.productUpdate?.userErrors ?? [];
        if (userErrors.length) {
          throw new Error(userErrors.map((e: any) => e.message).join(", "));
        }

        await prisma.productSeoData.upsert({
          where: { shop_productId: { shop: session.shop, productId: item.productId } },
          create: {
            shop: session.shop,
            productId: item.productId,
            generatedSchema: payload.jsonLd,
            schemaApplied: true,
          },
          update: {
            generatedSchema: payload.jsonLd,
            schemaApplied: true,
          },
        });
      }

      await prisma.seoChangeQueue.update({
        where: { id: itemId },
        data: { status: "applied", appliedAt: new Date(), error: null },
      });

      return { intent: "apply", id: itemId };
    } catch (e) {
      await prisma.seoChangeQueue.update({
        where: { id: itemId },
        data: { status: "failed", error: String(e) },
      });
      return { intent: "apply", error: String(e), id: itemId };
    }
  }

  return { error: "Unknown intent" };
};

export default function ApprovalQueue() {
  const { items } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const isApplying =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "apply";
  const isSkipping =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "skip";

  function applyItem(id: string) {
    const fd = new FormData();
    fd.set("intent", "apply");
    fd.set("itemId", id);
    fetcher.submit(fd, { method: "post" });
  }

  function skipItem(id: string) {
    const fd = new FormData();
    fd.set("intent", "skip");
    fd.set("itemId", id);
    fetcher.submit(fd, { method: "post" });
  }

  return (
    <s-page heading="Approval Queue">
      {items.length === 0 ? (
        <s-section>
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              color: "#8c9196",
              background: "#f6f6f7",
              borderRadius: 8,
              fontSize: 14,
            }}
          >
            No pending changes.
          </div>
        </s-section>
      ) : (
        <s-section heading={`Pending Changes (${items.length})`}>
          <div style={{ border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 120px 160px 220px",
                gap: 12,
                padding: "10px 16px",
                background: "#f6f6f7",
                fontWeight: 600,
                fontSize: 13,
                color: "#3d4044",
                borderBottom: "1px solid #e1e3e5",
              }}
            >
              <span>Product</span>
              <span>Type</span>
              <span>Created</span>
              <span>Actions</span>
            </div>

            {items.map((item: QueueItem, idx: number) => {
              const payload = (() => { try { return JSON.parse(item.payload); } catch { return null; } })();
              const preview =
                item.changeType === "meta"
                  ? `${payload?.metaTitle ?? ""} / ${payload?.metaDescription ?? ""}`
                  : "JSON-LD schema";

              return (
                <div
                  key={item.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 120px 160px 220px",
                    gap: 12,
                    padding: "10px 16px",
                    borderBottom: idx < items.length - 1 ? "1px solid #e1e3e5" : "none",
                    alignItems: "center",
                    background: "white",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 13, color: "#3d4044" }}>{item.productTitle}</span>
                    <span style={{ fontSize: 12, color: "#6d7175" }}>{preview}</span>
                  </div>
                  <span style={{ fontSize: 12, color: "#6d7175" }}>
                    {item.changeType === "meta" ? "Meta" : "Schema"}
                  </span>
                  <span style={{ fontSize: 12, color: "#6d7175" }}>
                    {new Date(item.createdAt).toLocaleDateString()}
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => applyItem(item.id)}
                      disabled={isApplying}
                      style={{
                        padding: "4px 10px",
                        background: "#008060",
                        color: "white",
                        border: "none",
                        borderRadius: 4,
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      {isApplying ? "Applying…" : "Apply"}
                    </button>
                    <button
                      onClick={() => skipItem(item.id)}
                      disabled={isSkipping}
                      style={{
                        padding: "4px 10px",
                        background: "#f6f6f7",
                        color: "#3d4044",
                        border: "1px solid #c9cccf",
                        borderRadius: 4,
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      {isSkipping ? "Skipping…" : "Skip"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
