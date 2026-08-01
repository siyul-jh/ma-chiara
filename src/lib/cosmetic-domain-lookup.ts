// cosmetic-domains.json의 키를 호스트명으로 조회하기 위한 후보 키 생성.
//
// EasyList의 `domain.com##selector`는 하위 도메인에도 적용되고, TLD 자리에
// 와일드카드를 쓰는 형태(`amazon.*`, `www.google.*`)도 흔하다. 7,681개 키를
// 매번 정규식으로 훑는 대신, 호스트명에서 매칭될 수 있는 키 후보를 만들어
// 맵을 직접 조회한다.

/** 와일드카드로 치환해볼 최대 TLD 라벨 수 (`amazon.co.uk` → `amazon.*`). */
const MAX_WILDCARD_LABELS = 2;

/**
 * `www.amazon.co.uk` → `www.amazon.co.uk`, `www.amazon.co.*`, `www.amazon.*`,
 * `amazon.co.uk`, `amazon.co.*`, `amazon.*`, `co.uk`, `co.*`
 *
 * 최상위 도메인 단독(`com`)은 후보에서 제외한다 — 그런 키에 매칭시키면 모든
 * 사이트에 규칙이 걸린다.
 */
export function cosmeticDomainLookupKeys(hostname: string): string[] {
  if (!hostname) return [];
  const labels = hostname.split(".");
  const keys: string[] = [];

  for (let start = 0; start < labels.length - 1; start += 1) {
    const suffix = labels.slice(start);
    keys.push(suffix.join("."));
    for (let k = 1; k <= MAX_WILDCARD_LABELS && suffix.length - k >= 1; k += 1) {
      keys.push([...suffix.slice(0, suffix.length - k), "*"].join("."));
    }
  }

  return [...new Set(keys)];
}

/** 호스트명에 해당하는 도메인 특화 선택자를 모두 모은다. */
export function collectDomainSelectors(
  hostname: string,
  domainMap: Record<string, string[] | undefined>,
): string[] {
  const collected = new Set<string>();
  for (const key of cosmeticDomainLookupKeys(hostname)) {
    for (const selector of domainMap[key] ?? []) {
      collected.add(selector);
    }
  }
  return [...collected];
}
