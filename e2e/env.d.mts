export const PORTS: {
  backend: number;
  backendB: number;
  backendLb: number;
  storefront: number;
  mockVnpay: number;
};
export const URLS: {
  backend: string;
  backendB: string;
  backendLb: string;
  storefront: string;
  mockVnpay: string;
};
export const E2E_DB_NAME: string;
export const ADMIN_DB_URL: string;
export const DATABASE_URL: string;
export const REDIS_URL: string;
export const VNPAY: { tmnCode: string; hashSecret: string };
export const CATALOG_REVALIDATE_SECRET: string;
export const E2E_ADMIN: { email: string; password: string };
export function backendEnv(): Record<string, string>;
export function storefrontEnv(publishableKey: string): Record<string, string>;
