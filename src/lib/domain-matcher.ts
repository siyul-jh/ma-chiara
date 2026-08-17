// 글롭 스타일 와일드카드 도메인 패턴(예: "naver*.com", "*"는 0개 이상의
// 문자와 매칭)을 RegExp로 변환해 호스트명과 매칭시킨다. 정규식 특수문자를
// 먼저 이스케이프한 뒤 "*"만 ".*"로 치환하므로, 사용자 입력은 순수 정규식이
// 아니라 글롭으로 취급된다.

const REGEX_METACHARACTERS = /[.+?^${}()|[\]\\]/g;

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(REGEX_METACHARACTERS, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchesDomainPattern(hostname: string, pattern: string): boolean {
  if (pattern.length === 0) return false;
  return globToRegExp(pattern).test(hostname);
}

export function matchesAnyDomainPattern(hostname: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesDomainPattern(hostname, pattern));
}

export function findMatchingDomainPattern(
  hostname: string,
  patterns: readonly string[],
): string | undefined {
  return patterns.find((pattern) => matchesDomainPattern(hostname, pattern));
}

export function isValidDomainPattern(pattern: string): boolean {
  if (pattern.trim().length === 0) return false;
  try {
    globToRegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * 정확한 호스트명을 와일드카드 패턴 초안으로 바꿔 제안한다. 숫자 구간을
 * "*"로 치환하고, `wildcardSuffix`를 켜면 마지막 라벨(TLD)까지 바꾼다.
 * 최종 값은 사용자가 확인·수정 후 확정한다.
 */
export function suggestWildcardPattern(
  pattern: string,
  options?: { wildcardSuffix?: boolean },
): string {
  let result = pattern.replace(/\d+/g, "*");
  if (options?.wildcardSuffix) {
    const labels = result.split(".");
    if (labels.length >= 2) {
      labels[labels.length - 1] = "*";
      result = labels.join(".");
    }
  }
  return result;
}
