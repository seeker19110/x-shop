import { Module } from "@medusajs/framework/utils";
import AuditModuleService from "./service";

export const AUDIT_MODULE = "xAudit";

export default Module(AUDIT_MODULE, { service: AuditModuleService });
