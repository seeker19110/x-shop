/**
 * Bộ dữ liệu tải (đặc tả §10.3): N sản phẩm (mặc định 10.000) × màu × size = 5 SKU/sản phẩm (đúng 50.000 SKU khi
 * N = 10.000), tồn, giá VND nguyên, danh mục, thuộc tính thời trang, ảnh (SVG demo). TẤT ĐỊNH: không dùng ngẫu nhiên,
 * mọi giá trị là hàm của số thứ tự n → hai lần sinh cho hai DB giống hệt nhau.
 *
 * Sinh bằng SQL hàng loạt phía server (generate_series → INSERT … SELECT) trong MỘT giao dịch, trên DB đã migrate +
 * seed-catalog (cần region/kênh bán/kho/danh mục/từ điển/bảng size của seed). Chỉ ghi bảng của module Product,
 * Inventory, Pricing và bảng link; read model `catalog_variant_index` dựng sau bằng `rebuildCatalogIndex` (không SQL).
 * Chỉ dành cho DB tải dùng riêng — không chạy trên DB có dữ liệu thật.
 */

/** Hình dạng (màu × size) theo n % 4: 5 + 6 + 4 + 5 = 20 SKU mỗi 4 sản phẩm → đúng 5 SKU/sản phẩm. */
export const SHAPES = [
  { colors: 1, sizes: 5 },
  { colors: 2, sizes: 3 },
  { colors: 2, sizes: 2 },
  { colors: 1, sizes: 5 },
];

/** Số SKU kỳ vọng của N sản phẩm (tính bằng đúng quy tắc SHAPES) — dùng để kiểm sau khi sinh. */
export function expectedSkuCount(n) {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const s = SHAPES[i % 4];
    total += s.colors * s.sizes;
  }
  return total;
}

export const HANDLE_PREFIX = "sp-load-";
const pad = (v) => `lpad(${v}::text, 5, '0')`;

/** Câu SQL sinh dữ liệu (mỗi phần tử một câu lệnh, chạy tuần tự trong một giao dịch). */
export function datasetStatements(n) {
  if (!Number.isInteger(n) || n < 1 || n > 99_999) throw new Error(`Số sản phẩm không hợp lệ: ${n}`);
  const P = `lp.n`;
  return [
    `CREATE TEMP TABLE lp ON COMMIT DROP AS
     SELECT g AS n,
            'prod_LD' || ${pad("g")} AS id,
            CASE g % 4 WHEN 0 THEN 1 WHEN 1 THEN 2 WHEN 2 THEN 2 ELSE 1 END AS nc,
            CASE g % 4 WHEN 0 THEN 5 WHEN 1 THEN 3 WHEN 2 THEN 2 ELSE 5 END AS ns,
            g % 6 AS cat,
            g % 9 AS mat,
            timestamptz '2026-01-01 00:00:00+00' + (g * interval '1 second') AS ts
       FROM generate_series(1, ${n}) g`,
    `ALTER TABLE lp ADD COLUMN cat_handle text, ADD COLUMN title text, ADD COLUMN mat_value text, ADD COLUMN mat_label text, ADD COLUMN price integer`,
    `UPDATE lp SET
       cat_handle = (ARRAY['ao-nu','quan-nu','vay-dam','ao-nam','quan-nam','giay'])[cat + 1],
       mat_value  = (ARRAY['len','lua','polyester','voan','denim','da','linen','kaki','cotton'])[mat + 1],
       mat_label  = (ARRAY['Len','Lụa','Polyester','Voan','Denim','Da','Linen','Kaki','Cotton'])[mat + 1],
       price      = (99 + (n * 37) % 400) * 1000`,
    `UPDATE lp SET title =
       (CASE cat
          WHEN 0 THEN (ARRAY['Áo sơ mi','Áo thun','Áo kiểu','Áo len'])[n % 4 + 1]
          WHEN 1 THEN (ARRAY['Quần jeans','Quần tây','Quần culottes','Quần short'])[n % 4 + 1]
          WHEN 2 THEN (ARRAY['Váy midi','Đầm suông','Đầm xòe','Chân váy'])[n % 4 + 1]
          WHEN 3 THEN (ARRAY['Áo polo','Áo sơ mi nam','Áo thun nam','Áo khoác nam'])[n % 4 + 1]
          WHEN 4 THEN (ARRAY['Quần kaki','Quần jeans nam','Quần short nam','Quần tây nam'])[n % 4 + 1]
          ELSE (ARRAY['Giày sneaker','Giày lười','Sandal','Giày cao gót'])[n % 4 + 1]
        END) || ' ' || lower(mat_label) || ' mẫu ' || ${pad("n")}`,
    `CREATE UNIQUE INDEX ON lp (n)`,

    // Biến thể: (sản phẩm, màu ci, size si). Màu: 9 màu từ điển, bước 2 (nguyên tố cùng 9 → không trùng trong 1 SP).
    `CREATE TEMP TABLE lc ON COMMIT DROP AS
     SELECT value, label, row_number() OVER (ORDER BY rank) - 1 AS r FROM fashion_color`,
    `CREATE TEMP TABLE lv ON COMMIT DROP AS
     SELECT lp.n, lp.id AS pid, c.ci, s.si, lp.nc, lp.ns, lp.cat, lp.price, lp.title, lp.ts,
            lc.value AS color, lc.label AS color_label,
            (CASE WHEN lp.cat = 5
               THEN (ARRAY['38','39','40','41','42'])[(CASE lp.ns WHEN 5 THEN 1 WHEN 3 THEN 2 ELSE 3 END) + s.si]
               ELSE (ARRAY['xs','s','m','l','xl'])[(CASE lp.ns WHEN 5 THEN 1 WHEN 3 THEN 2 ELSE 3 END) + s.si]
             END) AS size
       FROM lp
       JOIN LATERAL generate_series(0, lp.nc - 1) c(ci) ON true
       JOIN LATERAL generate_series(0, lp.ns - 1) s(si) ON true
       JOIN lc ON lc.r = (lp.n * 3 + c.ci * 2) % 9`,
    `ALTER TABLE lv ADD COLUMN vid text, ADD COLUMN sku text, ADD COLUMN rank integer, ADD COLUMN size_label text,
       ADD COLUMN stock integer, ADD COLUMN seq integer`,
    `UPDATE lv SET
       vid = 'variant_LD' || ${pad("n")} || ci::text || si::text,
       sku = 'LD' || ${pad("n")} || '-' || upper(color) || '-' || upper(size),
       rank = ci * ns + si,
       size_label = upper(size),
       seq = n * 10 + ci * 5 + si`,
    // Tồn tất định: 5% SKU hết hàng (0), còn lại 5..60.
    `UPDATE lv SET stock = CASE WHEN seq % 20 = 0 THEN 0 ELSE 5 + (seq * 7) % 56 END`,
    `CREATE UNIQUE INDEX ON lv (vid)`,
    `CREATE INDEX ON lv (n)`,
    `ANALYZE lp`,
    `ANALYZE lv`,

    `INSERT INTO product (id, title, handle, description, is_giftcard, status, thumbnail, discountable, created_at, updated_at, metadata)
     SELECT id, title, '${HANDLE_PREFIX}' || ${pad(P)}, title || ' — dữ liệu tải tổng hợp (không phải sản phẩm thật).',
            false, 'published',
            '/static/demo/' || (SELECT value FROM lc WHERE lc.r = (lp.n * 3) % 9) || '.svg?view=front',
            true, ts, ts, '{"load": true, "seed": "x-shop-load"}'::jsonb
       FROM lp`,
    `INSERT INTO product_category_product (product_id, product_category_id)
     SELECT lp.id, pc.id FROM lp JOIN product_category pc ON pc.handle = lp.cat_handle AND pc.deleted_at IS NULL`,
    // Thêm mỗi sản phẩm vào danh mục cha (để trang danh mục cha liệt kê cả con): đã có lineage trong read model, không cần.
    `INSERT INTO product_sales_channel (id, product_id, sales_channel_id)
     SELECT 'prodsc_LD' || ${pad(P)}, lp.id, (SELECT sales_channel_id FROM product_sales_channel WHERE deleted_at IS NULL AND id NOT LIKE 'prodsc_LD%' LIMIT 1)
       FROM lp`,

    // Option Màu/Size + giá trị + liên kết.
    `INSERT INTO product_option (id, title, is_exclusive)
     SELECT 'opt_LD' || ${pad(P)} || 'c', 'Màu', true FROM lp
     UNION ALL SELECT 'opt_LD' || ${pad(P)} || 's', 'Size', true FROM lp`,
    `INSERT INTO product_product_option (id, product_id, product_option_id)
     SELECT 'prodopt_LD' || ${pad(P)} || 'c', lp.id, 'opt_LD' || ${pad(P)} || 'c' FROM lp
     UNION ALL SELECT 'prodopt_LD' || ${pad(P)} || 's', lp.id, 'opt_LD' || ${pad(P)} || 's' FROM lp`,
    `CREATE TEMP TABLE lov ON COMMIT DROP AS
     SELECT DISTINCT n, pid, 'c' AS kind, ci AS idx, color AS value FROM lv
     UNION ALL SELECT DISTINCT n, pid, 's', si, size FROM lv`,
    `INSERT INTO product_option_value (id, value, option_id)
     SELECT 'optval_LD' || ${pad("n")} || kind || idx::text, value, 'opt_LD' || ${pad("n")} || kind FROM lov`,
    `INSERT INTO product_product_option_value (id, product_product_option_id, product_option_value_id)
     SELECT 'prodoptval_LD' || ${pad("n")} || kind || idx::text, 'prodopt_LD' || ${pad("n")} || kind,
            'optval_LD' || ${pad("n")} || kind || idx::text FROM lov`,

    `INSERT INTO product_variant (id, title, sku, allow_backorder, manage_inventory, variant_rank, product_id, created_at, updated_at)
     SELECT vid, color_label || ' / ' || size_label, sku, false, true, rank, pid, ts, ts FROM lv`,
    `INSERT INTO product_variant_option (variant_id, option_value_id)
     SELECT vid, 'optval_LD' || ${pad("n")} || 'c' || ci::text FROM lv
     UNION ALL SELECT vid, 'optval_LD' || ${pad("n")} || 's' || si::text FROM lv`,

    // Giá: price_set + price (VND nguyên, không rule) + link.
    `INSERT INTO price_set (id) SELECT 'pset_LD' || substr(vid, 11) FROM lv`,
    `INSERT INTO price (id, price_set_id, currency_code, raw_amount, rules_count, amount)
     SELECT 'price_LD' || substr(vid, 11), 'pset_LD' || substr(vid, 11), 'vnd',
            jsonb_build_object('value', price::text, 'precision', 20), 0, price FROM lv`,
    `INSERT INTO product_variant_price_set (id, variant_id, price_set_id)
     SELECT 'pvps_LD' || substr(vid, 11), vid, 'pset_LD' || substr(vid, 11) FROM lv`,

    // Tồn: inventory_item + link biến thể + level ở kho bán của seed.
    `INSERT INTO inventory_item (id, sku, requires_shipping, title, description)
     SELECT 'iitem_LD' || substr(vid, 11), sku, true, color_label || ' / ' || size_label, color_label || ' / ' || size_label FROM lv`,
    `INSERT INTO product_variant_inventory_item (id, variant_id, inventory_item_id, required_quantity)
     SELECT 'pvitem_LD' || substr(vid, 11), vid, 'iitem_LD' || substr(vid, 11), 1 FROM lv`,
    `INSERT INTO inventory_level (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity, incoming_quantity,
                                  raw_stocked_quantity, raw_reserved_quantity, raw_incoming_quantity)
     SELECT 'ilev_LD' || substr(vid, 11), 'iitem_LD' || substr(vid, 11),
            (SELECT location_id FROM inventory_level WHERE id NOT LIKE 'ilev_LD%' AND deleted_at IS NULL LIMIT 1),
            stock, 0, 0,
            jsonb_build_object('value', stock::text, 'precision', 20),
            '{"value": "0", "precision": 20}'::jsonb, '{"value": "0", "precision": 20}'::jsonb FROM lv`,

    // Ảnh: 3 góc chụp mỗi màu (như seed demo), metadata.color để read model chọn thumbnail theo màu.
    `INSERT INTO image (id, url, metadata, rank, product_id)
     SELECT 'img_LD' || ${pad("n")} || ci::text || v.vi::text,
            '/static/demo/' || color || '.svg?view=' || (ARRAY['front','back','detail'])[v.vi + 1],
            jsonb_build_object('color', color, 'set', color, 'width', 800, 'height', 1000, 'load', true,
                               'alt', title || ' màu ' || lower(color_label)),
            ci * 3 + v.vi, pid
       FROM (SELECT DISTINCT n, ci, pid, color, color_label, title FROM lv) c
       CROSS JOIN generate_series(0, 2) v(vi)`,

    // Thuộc tính thời trang + bảng size (theo danh mục).
    `INSERT INTO fashion_product_attributes (id, kind, material, material_label, composition, stretch, fit, care, origin)
     SELECT 'fattr_LD' || ${pad(P)}, CASE WHEN lp.cat = 5 THEN 'shoes' ELSE 'apparel' END, mat_value, mat_label,
            '100% ' || lower(mat_label), 'none', 'Suông', 'Giặt nhẹ, không tẩy, phơi trong bóng râm.', 'Việt Nam'
       FROM lp`,
    `INSERT INTO product_product_fashion_fashion_product_attributes (id, product_id, fashion_product_attributes_id)
     SELECT 'link_LDA' || ${pad(P)}, lp.id, 'fattr_LD' || ${pad(P)} FROM lp`,
    `INSERT INTO product_product_fashion_size_chart (id, product_id, size_chart_id)
     SELECT 'link_LDS' || ${pad(P)}, lp.id, sc.id FROM lp JOIN size_chart sc ON sc.code = lp.cat_handle`,
    `ANALYZE`,
  ];
}

/** Chạy toàn bộ sinh dữ liệu trên một client `pg` đã kết nối. Trả { products, variants } (đếm lại từ DB). */
export async function generateDataset(client, n, { onStep } = {}) {
  const have = await client.query("SELECT count(*)::int AS c FROM product WHERE handle LIKE $1", [
    `${HANDLE_PREFIX}%`,
  ]);
  if (have.rows[0].c > 0)
    throw new Error(`DB đã có ${have.rows[0].c} sản phẩm tải — dùng DB mới hoặc LOAD_REUSE=1`);
  await client.query("BEGIN");
  try {
    for (const sql of datasetStatements(n)) {
      if (sql === "ANALYZE") continue; // ANALYZE ngoài giao dịch
      const t = Date.now();
      await client.query(sql);
      onStep?.(sql.replace(/\s+/g, " ").slice(0, 60), Date.now() - t);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
  await client.query("ANALYZE");
  const r = await client.query(
    `SELECT (SELECT count(*)::int FROM product WHERE handle LIKE $1) AS products,
            (SELECT count(*)::int FROM product_variant WHERE id LIKE 'variant_LD%') AS variants`,
    [`${HANDLE_PREFIX}%`],
  );
  return r.rows[0];
}
