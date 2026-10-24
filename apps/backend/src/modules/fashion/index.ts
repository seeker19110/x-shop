import { Module } from "@medusajs/framework/utils";
import FashionModuleService from "./service";

export const FASHION_MODULE = "fashion";

export default Module(FASHION_MODULE, { service: FashionModuleService });
