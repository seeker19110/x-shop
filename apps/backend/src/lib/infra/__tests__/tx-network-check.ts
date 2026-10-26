import path from "node:path";
import ts from "typescript";

/**
 * Kiểm tĩnh DB-TX-003 (T-092): KHÔNG gọi mạng (HTTP vendor, Redis/khoá, hàng đợi, event bus) bên trong callback transaction
 * CSDL — giữ transaction mở trong lúc chờ mạng = giữ khoá, cạn pool, mất bản ghi khi crash sau lời gọi.
 *
 * Cách kiểm (dùng type checker của TypeScript, không đoán theo tên):
 *  - "Callback transaction" = đối số hàm của lời gọi `<x>.transaction(...)` / `<x>.transactional(...)` (knex, MikroORM, service
 *    của module tự viết).
 *  - Mỗi lời gọi trong callback được phân giải về KHAI BÁO. Khai báo nằm trong file/gói mạng (`NETWORK_SOURCES`) → vi phạm.
 *    Khai báo là hàm/method trong repo → đi tiếp vào thân nó (bắc cầu, có tập đã thăm) để bắt lời gọi mạng gián tiếp.
 *  - Hàm lồng (callback truyền tiếp) trong thân cũng được duyệt — chạy sau trong cùng transaction vẫn là trong transaction.
 */

/** Khai báo mạng: theo đường dẫn file (chuẩn hoá `/`). Gói ngoài khớp theo đoạn `node_modules/<gói>/`. */
export const NETWORK_SOURCES: ReadonlyArray<{
  label: string;
  test: (file: string, name: string) => boolean;
}> = [
  {
    label: "fetch (HTTP)",
    test: (f, n) =>
      n === "fetch" &&
      /(lib\.dom\.d\.ts|undici-types|lib\.webworker|@types\/node\/web-globals\/fetch\.d\.ts)/.test(f),
  },
  {
    label: "node:http/https/net/tls",
    test: (f) => /@types\/node\/(http|https|http2|net|tls|dns)\.d\.ts$/.test(f),
  },
  { label: "ioredis", test: (f) => f.includes("/node_modules/ioredis/") },
  { label: "bullmq", test: (f) => f.includes("/node_modules/bullmq/") },
  { label: "Locking Module", test: (f) => /@medusajs\/types\/dist\/locking\//.test(f) },
  { label: "Event Bus", test: (f) => /@medusajs\/types\/dist\/event-bus\//.test(f) },
  { label: "VNPAY gateway", test: (f) => f.endsWith("/src/lib/checkout/vnpay-gateway.ts") },
  { label: "khoá Redis checkout", test: (f) => f.endsWith("/src/lib/checkout/locks.ts") },
  { label: "cổng hoàn tiền", test: (f) => f.endsWith("/src/workflows/returns/refund-gateway.ts") },
  { label: "GHN client", test: (f) => f.endsWith("/src/lib/shipping/ghn-client.ts") },
  { label: "adapter thông báo", test: (f) => f.endsWith("/src/lib/notify/adapters.ts") },
];

export interface TxNetworkViolation {
  /** file:line của lời gọi transaction. */
  transaction: string;
  /** file:line của lời gọi mạng (có thể nằm trong hàm được gọi bắc cầu). */
  call: string;
  /** Chuỗi gọi từ callback tới lời gọi mạng. */
  via: string[];
  network: string;
}

const TX_METHODS = new Set(["transaction", "transactional"]);

const norm = (f: string) => f.split(path.sep).join("/");

function where(node: ts.Node, root: string): string {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${norm(path.relative(root, sf.fileName))}:${line + 1}`;
}

function calleeName(call: ts.CallExpression | ts.NewExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return "";
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) ||
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n)
  );
}

/** Khai báo được gọi (đi qua alias import). */
function declarationOf(
  checker: ts.TypeChecker,
  call: ts.CallExpression | ts.NewExpression,
): ts.Declaration[] {
  const out: ts.Declaration[] = [];
  const sig = checker.getResolvedSignature(call);
  if (sig?.declaration && !ts.isJSDocSignature(sig.declaration)) out.push(sig.declaration);
  const target = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  let sym = checker.getSymbolAtLocation(target);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  for (const d of sym?.declarations ?? []) if (!out.includes(d)) out.push(d);
  return out;
}

/** Thân hàm của khai báo trong repo (biến `const f = () => …` cũng tính). */
function bodyOf(decl: ts.Declaration): ts.Node | null {
  if (isFunctionLike(decl)) return decl.body ?? null;
  if (ts.isVariableDeclaration(decl) && decl.initializer && isFunctionLike(decl.initializer)) {
    return decl.initializer.body ?? null;
  }
  if (ts.isPropertyDeclaration(decl) && decl.initializer && isFunctionLike(decl.initializer)) {
    return decl.initializer.body ?? null;
  }
  return null;
}

export function findTxNetworkCalls(
  program: ts.Program,
  root: string,
  files: readonly string[],
): TxNetworkViolation[] {
  const checker = program.getTypeChecker();
  const rootN = norm(root);
  const inRepo = (f: string) => norm(f).startsWith(`${rootN}/`) && !norm(f).includes("/node_modules/");
  const violations: TxNetworkViolation[] = [];

  const scan = (body: ts.Node, tx: string, via: string[], visited: Set<ts.Node>): void => {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const name = calleeName(n);
        for (const decl of declarationOf(checker, n)) {
          const file = norm(decl.getSourceFile().fileName);
          const hit = NETWORK_SOURCES.find((s) => s.test(file, name));
          if (hit) {
            violations.push({
              transaction: tx,
              call: where(n, root),
              via: [...via, name],
              network: hit.label,
            });
            break;
          }
          if (inRepo(file)) {
            const b = bodyOf(decl);
            if (b && !visited.has(b)) {
              visited.add(b);
              scan(b, tx, [...via, name], visited);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
  };

  for (const fileName of files) {
    const sf = program.getSourceFile(fileName);
    if (!sf) continue;
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        TX_METHODS.has(n.expression.name.text)
      ) {
        for (const arg of n.arguments) {
          if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
            scan(arg.body, where(n, root), [], new Set([arg.body]));
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return violations;
}

/** Program theo tsconfig.typecheck.json của backend cho danh sách file. */
export function createBackendProgram(backendDir: string, files: readonly string[]): ts.Program {
  const configPath = path.join(backendDir, "tsconfig.typecheck.json");
  const read = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, backendDir);
  return ts.createProgram({ rootNames: [...files], options: { ...parsed.options, noEmit: true } });
}
