import { describe, expect, it } from "vitest";
import { evaluateCondition, preprocessFilterList } from "./filter-preprocessor";

describe("evaluateCondition", () => {
  it("크롬 MV3 상수만 참으로 본다", () => {
    expect(evaluateCondition("adguard")).toBe(true);
    expect(evaluateCondition("adguard_ext_chromium_mv3")).toBe(true);
    expect(evaluateCondition("adguard_app_ios")).toBe(false);
  });

  it("부정·논리 연산·괄호를 평가한다", () => {
    expect(evaluateCondition("!adguard_ext_android_cb")).toBe(true);
    expect(evaluateCondition("(adguard_app_ios || adguard_ext_safari)")).toBe(false);
    expect(evaluateCondition("(adguard && adguard_app_mac)")).toBe(false);
    expect(evaluateCondition("adguard && (adguard_ext_firefox || adguard_ext_chromium)")).toBe(true);
    expect(evaluateCondition("adguard_app_ios || adguard && !adguard_ext_safari")).toBe(true);
  });

  it("잘못된 식은 조용히 넘기지 않는다", () => {
    expect(() => evaluateCondition("(adguard")).toThrow();
    expect(() => evaluateCondition("adguard &&")).toThrow();
    expect(() => evaluateCondition("")).toThrow();
  });
});

describe("preprocessFilterList", () => {
  const list = [
    "||common.example^",
    "!#if (adguard_app_ios || adguard_ext_safari)",
    "||ios-only.example^",
    "!#endif",
    "!#if adguard",
    "||adguard.example^",
    "!#if adguard_app_windows",
    "||nested-windows.example^",
    "!#endif",
    "!#else",
    "||not-adguard.example^",
    "!#endif",
    "example.com##.ad",
  ].join("\n");

  it("해당하지 않는 분기와 지시문 줄을 걷어낸다", () => {
    expect(preprocessFilterList(list).split("\n")).toEqual([
      "||common.example^",
      "||adguard.example^",
      "example.com##.ad",
    ]);
  });

  it("짝이 맞지 않는 지시문은 오류로 알린다", () => {
    expect(() => preprocessFilterList("!#if adguard\n||a^")).toThrow();
    expect(() => preprocessFilterList("||a^\n!#endif")).toThrow();
    expect(() => preprocessFilterList("!#else")).toThrow();
  });
});
