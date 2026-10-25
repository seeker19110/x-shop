import { Module } from "@medusajs/framework/utils";
import NotifyModuleService from "./service";

/** Khóa đăng ký trong container: `container.resolve(NOTIFY_MODULE)`. */
export const NOTIFY_MODULE = "notify";

export default Module(NOTIFY_MODULE, { service: NotifyModuleService });

export type { default as NotifyModuleService } from "./service";
