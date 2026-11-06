import { GrantOwnerArgs } from "../grant-owner";

describe("grant-owner: đối số dòng lệnh qua zod (BASE-SEC-001)", () => {
  it("một email → chuẩn hoá chữ thường, bỏ khoảng trắng hai đầu", () => {
    expect(GrantOwnerArgs.parse(["  Chu@Example.TEST "])).toEqual(["chu@example.test"]);
  });

  it.each([
    ["không có đối số", []],
    ["chuỗi rỗng", [""]],
    ["chỉ khoảng trắng", ["   "]],
    ["thiếu @", ["khong-phai-email"]],
    ["thiếu phần local", ["@example.test"]],
    ["thiếu miền", ["a@"]],
    ["chứa khoảng trắng giữa", ["a b@example.test"]],
    ["chứa NUL", ["a\u0000@example.test"]],
    ["quá dài (> 254)", [`${"a".repeat(250)}@example.test`]],
    ["thừa đối số", ["a@example.test", "b@example.test"]],
    ["sai kiểu (số)", [5]],
    ["sai kiểu (null)", [null]],
  ])("từ chối: %s", (_name, args) => {
    expect(GrantOwnerArgs.safeParse(args).success).toBe(false);
  });

  it("Unicode trong email hợp lệ về cú pháp vẫn qua (tra cứu user quyết định tồn tại)", () => {
    expect(GrantOwnerArgs.safeParse(["đơn@example.test"]).success).toBe(true);
  });
});
