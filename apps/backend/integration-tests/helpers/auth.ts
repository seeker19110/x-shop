import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { createUserAccountWorkflow } from "@medusajs/medusa/core-flows";

/** Payload JWT không kiểm chữ ký — chỉ để đọc auth_identity_id của token đăng ký trong test. */
function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/** Phần tối thiểu của client HTTP (axios) mà test-utils cấp — axios không là phụ thuộc trực tiếp của backend. */
export interface HttpClient {
  post(url: string, body?: unknown, config?: unknown): Promise<{ data: Record<string, unknown> }>;
}

/**
 * Tạo admin thật qua luồng native (đăng ký emailpass → tạo user gắn auth identity → đăng nhập) và trả header Bearer.
 * Không giả token: route admin chạy đúng middleware authenticate của Medusa.
 */
export async function adminHeaders(api: HttpClient, container: MedusaContainer) {
  const email = `admin-${randomUUID()}@x-shop.test`;
  const password = `pw-${randomUUID()}`;
  const reg = await api.post("/auth/user/emailpass/register", { email, password });
  const authIdentityId = jwtPayload(String(reg.data.token)).auth_identity_id as string;
  const { result: user } = await createUserAccountWorkflow(container).run({
    input: { userData: { email }, authIdentityId },
  });
  const login = await api.post("/auth/user/emailpass", { email, password });
  return { userId: user.id, headers: { authorization: `Bearer ${String(login.data.token)}` } };
}

/** Header publishable key của kênh web (seed tạo) cho Store API. */
export async function storeHeaders(container: MedusaContainer, title = "Storefront x-shop") {
  const [key] = await container.resolve(Modules.API_KEY).listApiKeys({ title, type: "publishable" });
  if (!key) throw new Error("Chưa seed publishable key");
  return { "x-publishable-api-key": key.token };
}
