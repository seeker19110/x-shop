import { Module } from "@medusajs/framework/utils";
import ReturnsModuleService from "./service";

/** Khóa đăng ký trong container: `container.resolve(RETURNS_MODULE)` (T-027). */
export const RETURNS_MODULE = "xReturns";

export default Module(RETURNS_MODULE, { service: ReturnsModuleService });
