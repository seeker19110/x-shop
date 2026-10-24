import { Module } from "@medusajs/framework/utils";
import CatalogImportModuleService from "./service";

export const CATALOG_IMPORT_MODULE = "catalogImport";

export default Module(CATALOG_IMPORT_MODULE, { service: CatalogImportModuleService });
