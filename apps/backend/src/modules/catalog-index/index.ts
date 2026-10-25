import { Module } from "@medusajs/framework/utils";
import CatalogIndexModuleService from "./service";

export const CATALOG_INDEX_MODULE = "catalogIndex";

export default Module(CATALOG_INDEX_MODULE, { service: CatalogIndexModuleService });
