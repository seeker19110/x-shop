import { isNonEmpty as domainIsNonEmpty } from "@x-shop/domain";
import { isNonEmpty } from "./presence";

describe("isNonEmpty bản storefront (BASE-DATA-003)", () => {
  it('khớp bản domain: thiếu/rỗng → false; có nội dung (kể cả "0", " ") và Date → true', () => {
    for (const v of [null, undefined, "", " ", "0", "false", "id_1", new Date(0)]) {
      expect(isNonEmpty(v)).toBe(domainIsNonEmpty(v));
    }
    expect(isNonEmpty("")).toBe(false);
    expect(isNonEmpty("0")).toBe(true);
  });
});
