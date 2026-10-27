import type { ExecArgs, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  createApiKeysWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createStockLocationsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows";
import { withOwnedLock } from "../lib/checkout/locks";
import { isNonEmpty, secondsToMs } from "@x-shop/domain";

/**
 * Seed nền của x-shop — idempotent: chạy lại (kể cả hai tiến trình cùng lúc) không tạo bản ghi trùng.
 * Mỗi thực thể được tìm theo khoá tự nhiên (tên / mã quốc gia / tiêu đề) trước khi tạo; toàn bộ chạy dưới
 * khoá `x-shop:seed` của Locking Module (Redis khi có REDIS_URL).
 *
 * Chạy: `pnpm --filter @x-shop/backend seed` (= `medusa exec ./src/scripts/seed.ts`).
 */

export const SEED = {
  storeName: "x-shop",
  currencyCode: "vnd",
  regionName: "Việt Nam",
  countryCode: "vn",
  salesChannelName: "Website x-shop",
  salesChannelDescription: "Kênh bán trên website x-shop",
  sellableLocationName: "Kho chính",
  quarantineLocationName: "Kho cách ly",
  publishableKeyTitle: "Storefront x-shop",
  lockKey: "x-shop:seed",
} as const;

export interface SeedResult {
  storeId: string;
  regionId: string;
  salesChannelId: string;
  sellableLocationId: string;
  quarantineLocationId: string;
  publishableKeyId: string;
}

/** Thời gian chờ lấy khoá seed (giây) khi một tiến trình seed khác đang chạy. */
const SEED_LOCK_WAIT_SECONDS = 120;
/** Lease khoá seed — gia hạn nền khi còn chạy; tiến trình chết thì tự nhả sau ≤ 60 giây (như `locking.execute`). */
const SEED_LOCK_TTL_SECONDS = 60;

export default async function seedXShop({ container }: Pick<ExecArgs, "container">): Promise<SeedResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  // Mỗi lời gọi Redis có hạn (lib/checkout/locks.ts): Redis câm → LOCK_UNAVAILABLE thay vì treo tiến trình seed.
  const result = await withOwnedLock(
    container.resolve(Modules.LOCKING),
    SEED.lockKey,
    {
      waitMs: secondsToMs(SEED_LOCK_WAIT_SECONDS),
      ttlSeconds: SEED_LOCK_TTL_SECONDS,
      scope: "seed",
      ownerPrefix: "seed",
      failOnLeaseLoss: true,
      onReleaseError: (e) =>
        logger.warn(`[seed] Nhả khoá lỗi/quá hạn (lease tự hết): ${(e as Error).message}`),
    },
    () => seedUnlocked(container),
  );
  logger.info(`[seed] Xong: store=${result.storeId} region=${result.regionId}`);
  return result;
}

async function seedUnlocked(container: MedusaContainer): Promise<SeedResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const salesChannelId = await ensureSalesChannel(container);
  const regionId = await ensureRegion(container);
  const sellableLocationId = await ensureStockLocation(container, SEED.sellableLocationName);
  const quarantineLocationId = await ensureStockLocation(container, SEED.quarantineLocationName);
  // Kho chính bán qua kênh website; kho cách ly KHÔNG gắn kênh bán nào (hàng trả chờ kiểm định).
  await ensureLocationSalesChannel(container, sellableLocationId, salesChannelId);
  const publishableKeyId = await ensurePublishableKey(container, salesChannelId);
  const storeId = await ensureStore(container, {
    default_sales_channel_id: salesChannelId,
    default_region_id: regionId,
    default_location_id: sellableLocationId,
  });
  logger.info("[seed] Store VND, region Việt Nam, kênh bán, 2 kho và publishable key đã sẵn sàng.");
  return { storeId, regionId, salesChannelId, sellableLocationId, quarantineLocationId, publishableKeyId };
}

async function ensureSalesChannel(container: MedusaContainer): Promise<string> {
  const service = container.resolve(Modules.SALES_CHANNEL);
  const [existing] = await service.listSalesChannels({ name: SEED.salesChannelName });
  if (existing) return existing.id;
  const { result } = await createSalesChannelsWorkflow(container).run({
    input: {
      salesChannelsData: [{ name: SEED.salesChannelName, description: SEED.salesChannelDescription }],
    },
  });
  return firstId(result, "sales channel");
}

async function ensureRegion(container: MedusaContainer): Promise<string> {
  const service = container.resolve(Modules.REGION);
  // Khoá tự nhiên là quốc gia VN: một quốc gia chỉ thuộc một region (Region Module ràng buộc).
  const regions = await service.listRegions({}, { relations: ["countries"] });
  const existing = regions.find((r) => r.countries?.some((c) => c.iso_2 === SEED.countryCode));
  if (existing) {
    if (existing.currency_code !== SEED.currencyCode) {
      throw new Error(
        `[seed] Region chứa quốc gia "${SEED.countryCode}" đang dùng tiền "${existing.currency_code}", ` +
          `cần "${SEED.currencyCode}" — sửa tay rồi chạy lại.`,
      );
    }
    return existing.id;
  }
  const { result } = await createRegionsWorkflow(container).run({
    input: {
      regions: [
        {
          name: SEED.regionName,
          currency_code: SEED.currencyCode,
          countries: [SEED.countryCode],
        },
      ],
    },
  });
  return firstId(result, "region");
}

async function ensureStockLocation(container: MedusaContainer, name: string): Promise<string> {
  const service = container.resolve(Modules.STOCK_LOCATION);
  const [existing] = await service.listStockLocations({ name });
  if (existing) return existing.id;
  const { result } = await createStockLocationsWorkflow(container).run({
    input: { locations: [{ name }] },
  });
  return firstId(result, `stock location "${name}"`);
}

/** Hình tối thiểu cần đọc từ query.graph — không phụ thuộc kiểu sinh trong .medusa/types (chỉ có sau build). */
type LinkedSalesChannels = ReadonlyArray<{
  sales_channels?: ReadonlyArray<{ id?: string } | null | undefined> | null;
}>;

async function linkedSalesChannelIds(
  container: MedusaContainer,
  entity: "stock_location" | "api_key",
  id: string,
): Promise<string[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({ entity, fields: ["id", "sales_channels.id"], filters: { id } });
  const rows: LinkedSalesChannels = data;
  return (rows[0]?.sales_channels ?? []).flatMap((sc) => (sc && isNonEmpty(sc.id) ? [sc.id] : []));
}

async function ensureLocationSalesChannel(
  container: MedusaContainer,
  locationId: string,
  salesChannelId: string,
): Promise<void> {
  const linked = await linkedSalesChannelIds(container, "stock_location", locationId);
  if (linked.includes(salesChannelId)) return;
  await linkSalesChannelsToStockLocationWorkflow(container).run({
    input: { id: locationId, add: [salesChannelId] },
  });
}

async function ensurePublishableKey(container: MedusaContainer, salesChannelId: string): Promise<string> {
  const service = container.resolve(Modules.API_KEY);
  const [existing] = await service.listApiKeys({ title: SEED.publishableKeyTitle, type: "publishable" });
  let keyId = existing?.id;
  if (!isNonEmpty(keyId)) {
    const { result } = await createApiKeysWorkflow(container).run({
      input: { api_keys: [{ title: SEED.publishableKeyTitle, type: "publishable", created_by: "" }] },
    });
    keyId = firstId(result, "publishable API key");
  }
  const linked = await linkedSalesChannelIds(container, "api_key", keyId);
  if (!linked.includes(salesChannelId)) {
    await linkSalesChannelsToApiKeyWorkflow(container).run({
      input: { id: keyId, add: [salesChannelId] },
    });
  }
  return keyId;
}

async function ensureStore(
  container: MedusaContainer,
  defaults: { default_sales_channel_id: string; default_region_id: string; default_location_id: string },
): Promise<string> {
  const service = container.resolve(Modules.STORE);
  // Medusa tạo sẵn một store khi khởi động (createDefaultsWorkflow) — chỉ cập nhật, không tạo thêm.
  const [store] = await service.listStores({}, { relations: ["supported_currencies"] });
  if (!store) throw new Error("[seed] Không thấy store mặc định — Medusa chưa khởi tạo xong?");
  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: {
        name: SEED.storeName,
        supported_currencies: [{ currency_code: SEED.currencyCode, is_default: true }],
        ...defaults,
      },
    },
  });
  return store.id;
}

function firstId(rows: ReadonlyArray<{ id: string }>, what: string): string {
  const id = rows[0]?.id;
  if (!isNonEmpty(id)) throw new Error(`[seed] Tạo ${what} không trả về bản ghi.`);
  return id;
}
