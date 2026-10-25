import { Module } from "@medusajs/framework/utils";
import SettlementModuleService from "./service";

/** Khóa đăng ký trong container: `container.resolve(SETTLEMENT_MODULE)` (T-028). */
export const SETTLEMENT_MODULE = "xSettlement";

export default Module(SETTLEMENT_MODULE, { service: SettlementModuleService });
