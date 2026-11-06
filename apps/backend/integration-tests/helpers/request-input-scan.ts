import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * Kiểm tĩnh BASE-SEC-001: mã dự án không đọc thẳng `req.params` / `req.query` — chỉ qua `readParams`/`readQuery`/
 * `readQueryBag` (lib/http/request-input.ts, schema zod). Dùng TypeScript compiler API (không regex) nên không bị lừa
 * bởi chú thích, chuỗi chứa `//`, ép kiểu (`req!`, `as`, `satisfies`, `<any>`), ngoặc, destructuring tham số/biến.
 * Giới hạn: không theo dõi alias (`const r = req; r.query`) — nhưng chính phép gán/destructuring `req` đã bị bắt ở dạng
 * `const { query } = req`.
 */
const INPUT_PROPS = new Set(["params", "query"]);
const REQUEST_IDENT = /^(?:req|request)$/;

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isSatisfiesExpression(cur)
    )
      cur = cur.expression;
    else return cur;
  }
}

const isRequest = (e: ts.Expression): boolean => {
  const u = unwrap(e);
  return ts.isIdentifier(u) && REQUEST_IDENT.test(u.text);
};

const bindsInput = (pattern: ts.ObjectBindingPattern): boolean =>
  pattern.elements.some((el) => {
    const key = el.propertyName ?? el.name;
    return (ts.isIdentifier(key) || ts.isStringLiteral(key)) && INPUT_PROPS.has(key.text);
  });

/** Đoạn mã truy cập trực tiếp đầu vào request (rỗng = sạch). */
export function directRequestInputAccess(source: string, fileName = "x.ts"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      if (INPUT_PROPS.has(node.name.text) && isRequest(node.expression)) hits.push(node.getText(sf));
    } else if (ts.isElementAccessExpression(node)) {
      if (isRequest(node.expression)) {
        const arg = node.argumentExpression;
        const literal = ts.isStringLiteralLike(arg) ? arg.text : null;
        // Khoá động (`req[k]`) không chứng minh được là không phải params/query → coi là vi phạm.
        if (literal === null || INPUT_PROPS.has(literal)) hits.push(node.getText(sf));
      }
    } else if (ts.isObjectBindingPattern(node) && bindsInput(node)) {
      const parent = node.parent;
      const fromRequest =
        (ts.isVariableDeclaration(parent) &&
          parent.initializer !== undefined &&
          isRequest(parent.initializer)) ||
        (ts.isParameter(parent) && parent.type !== undefined && /Request\b/.test(parent.type.getText(sf)));
      if (fromRequest) hits.push(parent.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Mọi `.ts` dưới `srcDir` (bỏ `__tests__`, helper `request-input.ts`, giao diện admin) — khoá = đường dẫn tương đối `src/`. */
export function projectSources(srcDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || p === join(srcDir, "admin")) continue;
        walk(p);
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".d.ts") &&
        entry.name !== "request-input.ts"
      ) {
        out.set(relative(srcDir, p).split(sep).join("/"), readFileSync(p, "utf8"));
      }
    }
  };
  walk(srcDir);
  return out;
}
