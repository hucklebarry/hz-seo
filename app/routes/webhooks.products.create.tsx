import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { generateJsonLd, generateMetaForProduct, mapProductFromWebhook } from "../utils/seo-automation.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const rules = await prisma.automationRule.findMany({
    where: { shop, enabled: true },
  });

  const runMeta = rules.some((r) => r.ruleType === "product_create_meta");
  const runSchema = rules.some((r) => r.ruleType === "product_create_schema");

  if (!runMeta && !runSchema) {
    return new Response();
  }

  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const templateRules = settings?.templateRules
    ? (() => { try { return JSON.parse(settings.templateRules); } catch { return []; } })()
    : [];

  const product = mapProductFromWebhook(payload as Record<string, unknown>);

  const shopInfo = {
    name: shop,
    url: `https://${shop}`,
    currencyCode: "USD",
  };

  if (runMeta) {
    const meta = generateMetaForProduct(
      product,
      shopInfo,
      settings?.metaTitleTemplate ?? "{title} - {type} | {vendor}",
      settings?.metaDescTemplate ?? "",
      templateRules,
    );

    await prisma.seoChangeQueue.create({
      data: {
        shop,
        productId: product.id,
        productTitle: product.title,
        changeType: "meta",
        payload: JSON.stringify(meta),
      },
    });
  }

  if (runSchema) {
    const jsonLd = generateJsonLd(product, shopInfo);
    await prisma.seoChangeQueue.create({
      data: {
        shop,
        productId: product.id,
        productTitle: product.title,
        changeType: "schema",
        payload: JSON.stringify({ jsonLd }),
      },
    });
  }

  return new Response();
};
