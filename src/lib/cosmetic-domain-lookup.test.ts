import { describe, expect, it } from "vitest";
import { collectDomainSelectors, cosmeticDomainLookupKeys } from "./cosmetic-domain-lookup";

describe("cosmeticDomainLookupKeys", () => {
  it("호스트명 자신과 TLD 와일드카드 형태를 만든다", () => {
    expect(cosmeticDomainLookupKeys("youtube.com")).toEqual(["youtube.com", "youtube.*"]);
  });

  it("상위 도메인까지 거슬러 올라간다", () => {
    const keys = cosmeticDomainLookupKeys("www.amazon.com");
    expect(keys).toContain("www.amazon.com");
    expect(keys).toContain("amazon.com");
    expect(keys).toContain("amazon.*");
  });

  // EasyList에는 `amazon.*`처럼 다중 라벨 TLD까지 포괄하는 키가 있다.
  it("다중 라벨 TLD도 와일드카드로 치환한다", () => {
    const keys = cosmeticDomainLookupKeys("www.amazon.co.uk");
    expect(keys).toContain("amazon.co.uk");
    expect(keys).toContain("amazon.co.*");
    expect(keys).toContain("amazon.*");
  });

  // 이게 깨지면 `com` 키 하나로 모든 사이트에 규칙이 걸린다.
  it("최상위 도메인 단독은 후보에 넣지 않는다", () => {
    expect(cosmeticDomainLookupKeys("youtube.com")).not.toContain("com");
    expect(cosmeticDomainLookupKeys("www.amazon.com")).not.toContain("com");
  });

  it("중복 없이 돌려준다", () => {
    const keys = cosmeticDomainLookupKeys("a.b.c.d.com");
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("빈 호스트명은 빈 배열이다", () => {
    expect(cosmeticDomainLookupKeys("")).toEqual([]);
  });
});

describe("collectDomainSelectors", () => {
  const domainMap = {
    "youtube.com": ["#ad-slot", ".promoted"],
    "youtube.*": ["#ad-slot", ".shelf-ad"],
    "daum.net": [".daum-ad"],
  };

  it("여러 키에서 모은 뒤 중복을 제거한다", () => {
    const selectors = collectDomainSelectors("youtube.com", domainMap);
    expect(selectors.sort()).toEqual(["#ad-slot", ".promoted", ".shelf-ad"]);
  });

  it("하위 도메인도 상위 도메인 규칙을 물려받는다", () => {
    expect(collectDomainSelectors("m.youtube.com", domainMap)).toContain(".promoted");
  });

  it("매칭되는 키가 없으면 빈 배열이다", () => {
    expect(collectDomainSelectors("example.org", domainMap)).toEqual([]);
  });

  it("다른 도메인의 선택자를 섞지 않는다", () => {
    expect(collectDomainSelectors("youtube.com", domainMap)).not.toContain(".daum-ad");
  });
});
