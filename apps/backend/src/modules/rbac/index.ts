import { Module } from "@medusajs/framework/utils";
import RbacModuleService from "./service";

export const RBAC_MODULE = "xRbac";

export default Module(RBAC_MODULE, { service: RbacModuleService });
