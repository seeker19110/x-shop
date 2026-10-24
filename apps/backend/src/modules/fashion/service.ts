import { MedusaService } from "@medusajs/framework/utils";
import FashionColor from "./models/fashion-color";
import FashionSize from "./models/fashion-size";
import ModelMeasurement from "./models/model-measurement";
import FashionProductAttributes from "./models/product-attributes";
import SizeChart from "./models/size-chart";

class FashionModuleService extends MedusaService({
  FashionColor,
  FashionSize,
  SizeChart,
  FashionProductAttributes,
  ModelMeasurement,
}) {}

export default FashionModuleService;
