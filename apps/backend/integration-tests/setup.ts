import { MetadataStorage } from "@medusajs/framework/mikro-orm/core";

// Mỗi file test nạp lại model MikroORM — xoá metadata cũ để tránh trùng entity giữa các file (mẫu dtc-starter).
MetadataStorage.clear();
