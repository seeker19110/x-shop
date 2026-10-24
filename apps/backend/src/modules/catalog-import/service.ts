import { MedusaService } from "@medusajs/framework/utils";
import CatalogImportJob from "./models/import-job";

class CatalogImportModuleService extends MedusaService({ CatalogImportJob }) {}

export default CatalogImportModuleService;
