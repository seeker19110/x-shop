import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * T-171/D-081: rào tĩnh — mọi job dưới `src/jobs` (đệ quy, `.ts` và `.js`, bỏ `__tests__`: Medusa nạp job kiểu đệ quy,
 * @medusajs/framework resource-loader) phải chốt `isDraining()` ở đầu hàm mặc định, hoặc nằm trong danh sách ngoại lệ
 * kèm lý do. Job mới quên chốt → đỏ; mục ngoại lệ thừa (file không còn / đã có chốt / lý do rỗng) → đỏ.
 */

/** đường dẫn tương đối (dấu `/`, không đuôi) → lý do job cần chạy cả khi đang tắt. */
const DRAIN_EXEMPT: Record<string, string> = {};

const JOBS_DIR = join(__dirname, "..");

/** Mọi file job dưới `dir` (đệ quy), bỏ thư mục `__tests__` và `.d.ts`; trả đường dẫn tương đối dạng `a/b.ts`. */
function listJobFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== "__tests__") walk(join(d, e.name));
      } else if (/\.(ts|js)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
        out.push(relative(dir, join(d, e.name)).split(sep).join("/"));
      }
    }
  };
  walk(dir);
  return out.sort();
}

const jobKey = (rel: string) => rel.replace(/\.(ts|js)$/, "");

type Checked = { ok: true } | { ok: false; reason: string };

/** Khối lệnh của hàm mặc định (khai báo, biểu thức hàm/mũi tên, hoặc `export default <tên>` trỏ tới hàm cùng file). */
function defaultFunctionBody(sf: ts.SourceFile): ts.Block | null {
  const fnBody = (n: ts.Node | undefined): ts.Block | null =>
    n &&
    (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) &&
    n.body &&
    ts.isBlock(n.body)
      ? n.body
      : null;
  for (const st of sf.statements) {
    if (
      ts.isFunctionDeclaration(st) &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) === true &&
      st.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      return fnBody(st);
    if (ts.isExportAssignment(st) && st.isExportEquals !== true) {
      let e: ts.Expression = st.expression;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isIdentifier(e)) {
        const name = e.text;
        for (const s2 of sf.statements) {
          if (ts.isFunctionDeclaration(s2) && s2.name?.text === name) return fnBody(s2);
          if (ts.isVariableStatement(s2))
            for (const d of s2.declarationList.declarations)
              if (ts.isIdentifier(d.name) && d.name.text === name) return fnBody(d.initializer);
        }
        return null;
      }
      return fnBody(e);
    }
  }
  return null;
}

/** Câu lệnh đầu của hàm mặc định phải đúng `if (isDraining()) return;` (hoặc `{ return; }`), không else; bỏ comment. */
function checkDrainGuard(src: string, fileName = "job.ts"): Checked {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const body = defaultFunctionBody(sf);
  if (!body) return { ok: false, reason: "không có hàm mặc định dạng hàm có thân khối" };
  const first = body.statements[0];
  if (!first || !ts.isIfStatement(first) || first.elseStatement)
    return { ok: false, reason: "câu lệnh đầu không phải `if (isDraining()) return;`" };
  const c = first.expression;
  if (
    !ts.isCallExpression(c) ||
    !ts.isIdentifier(c.expression) ||
    c.expression.text !== "isDraining" ||
    c.arguments.length
  )
    return { ok: false, reason: "điều kiện không phải `isDraining()`" };
  let t: ts.Statement = first.thenStatement;
  if (ts.isBlock(t) && t.statements.length === 1) t = t.statements[0]!;
  if (!ts.isReturnStatement(t) || t.expression)
    return { ok: false, reason: "nhánh đúng không phải `return;` trần" };
  const hasImport = sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      /\/lib\/lifecycle\/shutdown$/.test(s.moduleSpecifier.text) &&
      !!s.importClause?.namedBindings &&
      ts.isNamedImports(s.importClause.namedBindings) &&
      s.importClause.namedBindings.elements.some(
        (el) => (el.propertyName ?? el.name).text === "isDraining" && el.name.text === "isDraining",
      ),
  );
  return hasImport
    ? { ok: true }
    : { ok: false, reason: "thiếu import isDraining từ lib/lifecycle/shutdown" };
}

/** Kiểm danh sách ngoại lệ với nội dung file (undefined = file không tồn tại); trả danh sách lỗi (rỗng = sạch). */
function checkExemptions(
  exempt: Record<string, string>,
  sources: Record<string, string | undefined>,
): string[] {
  const errs: string[] = [];
  for (const [key, reason] of Object.entries(exempt)) {
    if (!reason.trim()) errs.push(`${key}: lý do rỗng`);
    const src = sources[key];
    if (src === undefined) errs.push(`${key}: file không tồn tại`);
    else if (checkDrainGuard(src).ok) errs.push(`${key}: đã có chốt isDraining(), ngoại lệ thừa`);
  }
  return errs;
}

describe("rào tĩnh: job định kỳ kiểm isDraining() lúc bắt đầu", () => {
  const files = listJobFiles(JOBS_DIR);

  it("có job để kiểm (không quét rỗng)", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it.each(files.map((f) => [f]))("%s: isDraining() ở đầu hàm mặc định hoặc nằm trong ngoại lệ", (f) => {
    if (jobKey(f) in DRAIN_EXEMPT) return;
    expect(checkDrainGuard(readFileSync(join(JOBS_DIR, f), "utf8"), f)).toEqual({ ok: true });
  });

  it("danh sách ngoại lệ thật không có mục thừa", () => {
    const sources: Record<string, string | undefined> = {};
    for (const k of Object.keys(DRAIN_EXEMPT)) {
      const f = files.find((x) => jobKey(x) === k);
      sources[k] = f !== undefined ? readFileSync(join(JOBS_DIR, f), "utf8") : undefined;
    }
    expect(checkExemptions(DRAIN_EXEMPT, sources)).toEqual([]);
  });
});

describe("rào tĩnh: bộ kiểm (chuỗi mẫu)", () => {
  const IMP = `import { isDraining } from "../lib/lifecycle/shutdown";\n`;

  it("nhận chốt đúng, gồm comment đứng trước, kiểu trả về có `{`, dạng khối, mũi tên + export default tên", () => {
    expect(
      checkDrainGuard(
        `${IMP}export default async function j(c) {\n  // ghi chú\n  if (isDraining()) return;\n  await w(c);\n}`,
      ).ok,
    ).toBe(true);
    expect(
      checkDrainGuard(
        `${IMP}export default async function j(c: C): Promise<{ n: number } | void> {\n  if (isDraining()) return;\n}`,
      ).ok,
    ).toBe(true);
    expect(
      checkDrainGuard(`${IMP}export default async function j(c) {\n  if (isDraining()) { return; }\n}`).ok,
    ).toBe(true);
    expect(
      checkDrainGuard(`${IMP}const j = async (c) => {\n  if (isDraining()) return;\n};\nexport default j;`)
        .ok,
    ).toBe(true);
  });

  it("JSDoc chứa nguyên văn chữ ký hàm + chốt không lách được", () => {
    const src = `${IMP}/** ví dụ: export default async function x() {\n if (isDraining()) return;\n */\nexport default async function j(c) {\n  await w(c);\n}`;
    expect(checkDrainGuard(src).ok).toBe(false);
  });

  it("chốt bị comment, thiếu import, có else, trả giá trị, không phải câu đầu → đỏ", () => {
    expect(
      checkDrainGuard(
        `${IMP}export default async function j(c) {\n  // if (isDraining()) return;\n  await w(c);\n}`,
      ).ok,
    ).toBe(false);
    expect(
      checkDrainGuard(
        `${IMP}export default async function j(c) {\n  /* if (isDraining()) return; */\n  await w(c);\n}`,
      ).ok,
    ).toBe(false);
    expect(checkDrainGuard(`export default async function j(c) {\n  if (isDraining()) return;\n}`).ok).toBe(
      false,
    );
    expect(
      checkDrainGuard(
        `${IMP}export default async function j(c) {\n  if (isDraining()) return; else await w(c);\n}`,
      ).ok,
    ).toBe(false);
    expect(
      checkDrainGuard(`${IMP}export default async function j(c) {\n  if (isDraining()) return undefined;\n}`)
        .ok,
    ).toBe(false);
    expect(
      checkDrainGuard(
        `${IMP}export default async function j(c) {\n  await w(c);\n  if (isDraining()) return;\n}`,
      ).ok,
    ).toBe(false);
  });

  it("file không có hàm mặc định: báo rõ, không ném lỗi", () => {
    const r = checkDrainGuard(`${IMP}export const config = { name: "x" };`);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("không có hàm mặc định") });
  });

  it("ngoại lệ thừa: đã có chốt / lý do rỗng / file không tồn tại → có lỗi; hợp lệ → sạch", () => {
    const guarded = `${IMP}export default async function j(c) {\n  if (isDraining()) return;\n}`;
    const bare = `export default async function j(c) {\n  await w(c);\n}`;
    expect(checkExemptions({ a: "cần chạy khi tắt" }, { a: guarded })).toEqual([
      expect.stringContaining("ngoại lệ thừa"),
    ]);
    expect(checkExemptions({ a: "  " }, { a: bare })).toEqual([expect.stringContaining("lý do rỗng")]);
    expect(checkExemptions({ a: "lý do" }, { a: undefined })).toEqual([
      expect.stringContaining("không tồn tại"),
    ]);
    expect(checkExemptions({ a: "lý do" }, { a: bare })).toEqual([]);
  });
});

describe("rào tĩnh: quét đệ quy", () => {
  it("job trong thư mục con (.ts và .js) bị bắt; __tests__ và .d.ts bị bỏ qua", () => {
    const root = mkdtempSync(join(tmpdir(), "jobs-guard-"));
    try {
      mkdirSync(join(root, "sub", "deep"), { recursive: true });
      mkdirSync(join(root, "__tests__"));
      mkdirSync(join(root, "sub", "__tests__"));
      writeFileSync(join(root, "top.ts"), "");
      writeFileSync(join(root, "sub", "a.ts"), "");
      writeFileSync(join(root, "sub", "deep", "b.js"), "");
      writeFileSync(join(root, "sub", "types.d.ts"), "");
      writeFileSync(join(root, "__tests__", "t.ts"), "");
      writeFileSync(join(root, "sub", "__tests__", "t.ts"), "");
      writeFileSync(join(root, "sub", "note.md"), "");
      expect(listJobFiles(root)).toEqual(["sub/a.ts", "sub/deep/b.js", "top.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
