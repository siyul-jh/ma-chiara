import { describe, expect, it } from "vitest";
import {
  findMatchingDomainPattern,
  isValidDomainPattern,
  matchesAnyDomainPattern,
  matchesDomainPattern,
  suggestWildcardPattern,
} from "./domain-matcher";

describe("matchesDomainPattern", () => {
  it("정확한 호스트명을 매칭한다", () => {
    expect(matchesDomainPattern("naver.com", "naver.com")).toBe(true);
  });

  it("전체 문자열이 일치할 때만 매칭한다", () => {
    expect(matchesDomainPattern("www.naver.com", "naver.com")).toBe(false);
    expect(matchesDomainPattern("naver.com.evil.kr", "naver.com")).toBe(false);
  });

  // 이스케이프가 깨지면 "."이 임의의 한 글자와 매칭되어 엉뚱한 도메인까지
  // 규칙에 걸린다 — 조용히 잘못 동작하는 대표적 지점.
  it("정규식 메타문자를 리터럴로 취급한다", () => {
    expect(matchesDomainPattern("naverXcom", "naver.com")).toBe(false);
    expect(matchesDomainPattern("a+b.com", "a+b.com")).toBe(true);
    expect(matchesDomainPattern("aab.com", "a+b.com")).toBe(false);
  });

  it("*를 0글자 이상으로 확장한다", () => {
    expect(matchesDomainPattern("naver.com", "naver*.com")).toBe(true);
    expect(matchesDomainPattern("naversports.com", "naver*.com")).toBe(true);
    expect(matchesDomainPattern("sports.naver.com", "*.naver.com")).toBe(true);
    expect(matchesDomainPattern("naver.com", "*")).toBe(true);
  });

  it("대소문자를 구분하지 않는다", () => {
    expect(matchesDomainPattern("NAVER.com", "naver.com")).toBe(true);
  });

  it("빈 패턴은 아무것도 매칭하지 않는다", () => {
    expect(matchesDomainPattern("naver.com", "")).toBe(false);
  });
});

describe("matchesAnyDomainPattern", () => {
  it("하나라도 매칭되면 참이다", () => {
    expect(matchesAnyDomainPattern("naver.com", ["daum.net", "naver.com"])).toBe(true);
    expect(matchesAnyDomainPattern("naver.com", ["daum.net"])).toBe(false);
    expect(matchesAnyDomainPattern("naver.com", [])).toBe(false);
  });
});

describe("findMatchingDomainPattern", () => {
  it("처음 매칭된 패턴을 돌려준다", () => {
    expect(findMatchingDomainPattern("sports.naver.com", ["*.naver.com", "*"])).toBe("*.naver.com");
    expect(findMatchingDomainPattern("naver.com", ["daum.net"])).toBeUndefined();
  });
});

describe("isValidDomainPattern", () => {
  it("공백뿐인 입력을 거부한다", () => {
    expect(isValidDomainPattern("")).toBe(false);
    expect(isValidDomainPattern("   ")).toBe(false);
  });

  it("일반적인 글롭 패턴을 허용한다", () => {
    expect(isValidDomainPattern("naver*.com")).toBe(true);
    expect(isValidDomainPattern("*")).toBe(true);
  });

  // 메타문자를 이스케이프한 뒤 컴파일하므로 정규식으로는 깨질 입력도 안전하다.
  it("정규식이라면 깨질 입력도 글롭으로는 허용한다", () => {
    expect(isValidDomainPattern("a(b.com")).toBe(true);
    expect(isValidDomainPattern("[.com")).toBe(true);
  });
});

describe("suggestWildcardPattern", () => {
  it("숫자 구간을 *로 치환한다", () => {
    expect(suggestWildcardPattern("naver43.com")).toBe("naver*.com");
  });

  it("숫자 구간이 여러 곳이면 전부 치환한다", () => {
    expect(suggestWildcardPattern("www2.naver43.com")).toBe("www*.naver*.com");
  });

  it("숫자가 없으면 그대로 돌려준다", () => {
    expect(suggestWildcardPattern("naver.com")).toBe("naver.com");
  });

  it("wildcardSuffix를 켜면 마지막 라벨(TLD)도 *로 바꾼다", () => {
    expect(suggestWildcardPattern("naver43.com", { wildcardSuffix: true })).toBe("naver*.*");
    expect(suggestWildcardPattern("naver.com", { wildcardSuffix: true })).toBe("naver.*");
  });

  it("라벨이 하나뿐이면 wildcardSuffix를 무시한다", () => {
    expect(suggestWildcardPattern("localhost", { wildcardSuffix: true })).toBe("localhost");
  });
});
