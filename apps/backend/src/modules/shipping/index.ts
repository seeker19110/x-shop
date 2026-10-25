import { Module } from "@medusajs/framework/utils";
import ShippingModuleService from "./service";

/** Khóa đăng ký trong container: `container.resolve(SHIPPING_MODULE)`. */
export const SHIPPING_MODULE = "shipping";

export default Module(SHIPPING_MODULE, { service: ShippingModuleService });

export type { default as ShippingModuleService } from "./service";
