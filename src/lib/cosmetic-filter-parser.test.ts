import { describe, expect, it } from "vitest";
import { parseCosmeticFilterLine, parseCosmeticFilters } from "./cosmetic-filter-parser";

describe("parseCosmeticFilterLine", () => {
  it("도메인 없는 규칙을 범용으로 해석한다", () => {
    expect(parseCosmeticFilterLine("##.ad-banner")).toEqual({ domains: [], selector: ".ad-banner" });
  });

  it("도메인 규칙을 해석한다", () => {
    expect(parseCosmeticFilterLine("youtube.com###ad-slot")).toEqual({
      domains: ["youtube.com"],
      selector: "#ad-slot",
    });
  });

  it("여러 도메인을 나눈다", () => {
    expect(parseCosmeticFilterLine("a.com,b.com##.ad")?.domains).toEqual(["a.com", "b.com"]);
  });

  it("TLD 와일드카드 도메인을 허용한다", () => {
    expect(parseCosmeticFilterLine("amazon.*##.ad")?.domains).toEqual(["amazon.*"]);
  });

  it("도메인을 소문자로 정규화한다", () => {
    expect(parseCosmeticFilterLine("YouTube.COM##.ad")?.domains).toEqual(["youtube.com"]);
  });

  // 아래가 이 파서의 존재 이유다. 잘못 받아들이면 멀쩡한 요소가 사라진다.
  describe("지원하지 않는 문법은 버린다", () => {
    it("예외 규칙(#@#)", () => {
      expect(parseCosmeticFilterLine("a.com#@#.ad")).toBeNull();
    });

    it("확장 CSS(#?#)", () => {
      expect(parseCosmeticFilterLine("a.com#?#.ad:has(> .x)")).toBeNull();
    });

    it("스타일 주입(#$#)", () => {
      expect(parseCosmeticFilterLine("a.com#$#.ad { display: block }")).toBeNull();
    });

    it("스크립틀릿(+js)", () => {
      expect(parseCosmeticFilterLine("a.com##+js(nowebrtc)")).toBeNull();
    });

    it("HTML 필터링(^)", () => {
      expect(parseCosmeticFilterLine("a.com##^script:has-text(ads)")).toBeNull();
    });

    it("절차적 의사 클래스", () => {
      expect(parseCosmeticFilterLine("a.com##.ad:has-text(광고)")).toBeNull();
      expect(parseCosmeticFilterLine("a.com##.ad:-abp-contains(x)")).toBeNull();
      expect(parseCosmeticFilterLine("a.com##.ad:upward(2)")).toBeNull();
    });

    // 제외 도메인을 무시하고 적용하면 규칙이 명시적으로 빼둔 사이트까지 숨긴다.
    it("제외 도메인(~)이 섞인 규칙", () => {
      expect(parseCosmeticFilterLine("~a.com##.ad")).toBeNull();
      expect(parseCosmeticFilterLine("a.com,~sub.a.com##.ad")).toBeNull();
    });

    it("중괄호가 들어간 선택자", () => {
      expect(parseCosmeticFilterLine("a.com##.ad{color:red}")).toBeNull();
    });

    it("빈 선택자", () => {
      expect(parseCosmeticFilterLine("a.com##")).toBeNull();
    });

    it("지나치게 긴 선택자", () => {
      expect(parseCosmeticFilterLine(`a.com##.${"x".repeat(600)}`)).toBeNull();
    });

    it("도메인 자리가 도메인 형태가 아닌 줄", () => {
      expect(parseCosmeticFilterLine("||example.com/path##foo")).toBeNull();
      expect(parseCosmeticFilterLine("/ads/##.x")).toBeNull();
    });

    it("주석과 헤더", () => {
      expect(parseCosmeticFilterLine("! comment ##.ad")).toBeNull();
      expect(parseCosmeticFilterLine("[Adblock Plus 2.0]")).toBeNull();
    });

    it("요소 숨김이 아닌 네트워크 규칙", () => {
      expect(parseCosmeticFilterLine("||ads.example.com^$script")).toBeNull();
      expect(parseCosmeticFilterLine("||example.com/page#fragment")).toBeNull();
    });
  });
});

describe("parseCosmeticFilters", () => {
  const list = [
    "[Adblock Plus 2.0]",
    "! title: test",
    "##.generic-ad",
    "##.generic-ad",
    "youtube.com###player-ads",
    "youtube.com,m.youtube.com##.promoted",
    "a.com#@#.ad",
    "b.com##.ad:has-text(x)",
    "||ads.example.com^$script",
    "",
  ].join("\n");

  const parsed = parseCosmeticFilters(list);

  it("범용 선택자를 중복 없이 모은다", () => {
    expect(parsed.genericSelectors).toEqual([".generic-ad"]);
  });

  it("도메인별로 모은다", () => {
    expect(parsed.domainSelectors["youtube.com"]?.sort()).toEqual(["#player-ads", ".promoted"]);
    expect(parsed.domainSelectors["m.youtube.com"]).toEqual([".promoted"]);
  });

  it("지원하지 않는 요소 숨김 규칙만 건너뜀으로 센다", () => {
    // #@# 와 :has-text 두 줄. 네트워크 규칙과 주석은 세지 않는다.
    expect(parsed.skipped).toBe(2);
  });

  it("지원하지 않는 규칙의 선택자가 결과에 섞이지 않는다", () => {
    const all = [...parsed.genericSelectors, ...Object.values(parsed.domainSelectors).flat()];
    expect(all.some((s) => s.includes("has-text"))).toBe(false);
    expect(all).not.toContain(".ad");
  });

  it("빈 입력을 견딘다", () => {
    expect(parseCosmeticFilters("")).toEqual({
      genericSelectors: [],
      domainSelectors: {},
      skipped: 0,
    });
  });
});
