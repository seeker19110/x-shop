import { Module } from "@medusajs/framework/utils";
import CheckoutModuleService from "./service";

/** Khóa đăng ký trong container: `container.resolve(CHECKOUT_MODULE)`. */
export const CHECKOUT_MODULE = "checkout";

export default Module(CHECKOUT_MODULE, {
  service: CheckoutModuleService,
});

export type { default as CheckoutModuleService } from "./service";
