// EasyList 요소 숨김 규칙(`domain##selector`) 전용 런타임 파서.
//
// 빌드 시점에는 @adguard/tsurlfilter 엔진 전체를 쓰지만, 그걸 확장 프로그램에
// 번들하기에는 너무 무겁다. 런타임 갱신에는 순수 CSS 요소 숨김 규칙만
// 필요하므로 그 문법만 다루는 작은 파서를 따로 둔다.
//
// 원칙은 "의심스러우면 버린다"다. 잘못 해석한 규칙은 멀쩡한 페이지 요소를
// 숨겨버리므로, 조금이라도 지원 범위를 벗어나면 통째로 건너뛴다.

/** 지원하지 않는 확장 문법을 쓰는 선택자 조각. 하나라도 걸리면 규칙을 버린다. */
const PROCEDURAL_PSEUDO_CLASSES = [
  ":-abp-",
  ":has-text(",
  ":contains(",
  ":matches-css",
  ":matches-attr",
  ":matches-path",
  ":matches-property",
  ":xpath(",
  ":upward(",
  ":nth-ancestor(",
  ":watch-attr(",
  ":remove(",
  ":min-text-length(",
  ":style(",
  ":if(",
  ":if-not(",
  ":others(",
];

/** 도메인 자리에 올 수 있는 문자. `*`는 EasyList의 TLD 와일드카드다. */
const DOMAIN_PATTERN = /^[a-z0-9*][a-z0-9.\-_*]*$/;

const MAX_SELECTOR_LENGTH = 512;

export interface ParsedCosmeticFilters {
  /** 도메인 제한이 없는 선택자. */
  genericSelectors: string[];
  /** 도메인(또는 `amazon.*` 형태) → 선택자 목록. */
  domainSelectors: Record<string, string[]>;
  /** 지원 범위를 벗어나 건너뛴 줄 수. */
  skipped: number;
}

interface ParsedRule {
  domains: string[];
  selector: string;
}

function isSupportedSelector(selector: string): boolean {
  if (selector.length === 0 || selector.length > MAX_SELECTOR_LENGTH) return false;
  // 스크립틀릿(`##+js(...)`)과 HTML 필터링(`##^...`)은 CSS가 아니다.
  if (selector.startsWith("+js(") || selector.startsWith("^")) return false;
  // 스타일시트 문법을 깨거나 규칙 밖으로 새어나갈 수 있는 문자.
  if (selector.includes("{") || selector.includes("}")) return false;
  const lowered = selector.toLowerCase();
  return !PROCEDURAL_PSEUDO_CLASSES.some((pseudo) => lowered.includes(pseudo));
}

/**
 * 한 줄을 해석한다. 요소 숨김 규칙이 아니거나 지원 범위를 벗어나면 null.
 *
 * 도메인에는 `#`이 올 수 없으므로 첫 번째 `#`이 항상 구분자의 시작이다.
 * 거기서 정확히 `##`이 아니면(`#@#` 예외 규칙, `#?#` 확장 CSS, `#$#` 스타일
 * 주입 등) 지원 대상이 아니다.
 */
export function parseCosmeticFilterLine(rawLine: string): ParsedRule | null {
  const line = rawLine.trim();
  if (line.length === 0 || line.startsWith("!") || line.startsWith("[")) return null;

  const hashIndex = line.indexOf("#");
  if (hashIndex === -1) return null;
  if (!line.startsWith("##", hashIndex)) return null;

  const selector = line.slice(hashIndex + 2).trim();
  if (!isSupportedSelector(selector)) return null;

  const domainPart = line.slice(0, hashIndex).trim();
  if (domainPart.length === 0) return { domains: [], selector };

  const domains: string[] = [];
  for (const entry of domainPart.split(",")) {
    const domain = entry.trim().toLowerCase();
    if (domain.length === 0) return null;
    // 제외 도메인(`~a.com`)은 DNR/CSS로 표현할 수 없다. 무시하고 적용하면
    // 규칙이 명시적으로 빼둔 사이트까지 숨겨버리므로 규칙째로 버린다.
    if (domain.startsWith("~")) return null;
    if (!DOMAIN_PATTERN.test(domain)) return null;
    domains.push(domain);
  }

  return { domains, selector };
}

/**
 * 코스메틱 계열 구분자(`##`, `#@#`, `#?#`, `#$#` …)를 가진 줄인지 본다.
 * 구분자는 첫 `#`부터 최대 4글자 안에서 닫히므로, 그 범위에 `#`이 하나 더
 * 있는지로 판별한다. URL 조각(`...#fragment`) 같은 네트워크 규칙은 걸러진다.
 */
function looksLikeCosmeticRule(line: string): boolean {
  const first = line.indexOf("#");
  if (first === -1) return false;
  return line.slice(first, first + 4).lastIndexOf("#") > 0;
}

/** 필터 목록 텍스트 전체에서 지원 가능한 요소 숨김 규칙을 뽑아낸다. */
export function parseCosmeticFilters(text: string): ParsedCosmeticFilters {
  const generic = new Set<string>();
  const byDomain = new Map<string, Set<string>>();
  let skipped = 0;

  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("!") || trimmed.startsWith("[")) continue;

    const parsed = parseCosmeticFilterLine(trimmed);
    if (!parsed) {
      // 네트워크 규칙은 "건너뜀"으로 세지 않는다 — 이 숫자는 코스메틱 규칙
      // 중 지원하지 못한 비율을 보기 위한 것이다.
      if (looksLikeCosmeticRule(trimmed)) skipped += 1;
      continue;
    }

    if (parsed.domains.length === 0) {
      generic.add(parsed.selector);
      continue;
    }
    for (const domain of parsed.domains) {
      let set = byDomain.get(domain);
      if (!set) byDomain.set(domain, (set = new Set()));
      set.add(parsed.selector);
    }
  }

  const domainSelectors: Record<string, string[]> = {};
  for (const [domain, set] of byDomain) {
    domainSelectors[domain] = [...set];
  }

  return { genericSelectors: [...generic], domainSelectors, skipped };
}
