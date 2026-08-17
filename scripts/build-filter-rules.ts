/**
 * 빌드 타임 필터 파이프라인: EasyList + EasyPrivacy를 다음으로 변환한다:
 *   - src/rules/dnr-ruleset-*.json — 정적 declarativeNetRequest 룰셋
 *   - src/rules/cosmetic-selectors.json — 콘텐츠 스크립트/옵션 페이지가 import하는
 *     DOM 숨김용 CSS 선택자
 *   - public/rules/cosmetic-domains.json, rule-conditions-*.json,
 *     cosmetic-selectors.json — 서비스 워커가 fetch(chrome.runtime.getURL(...))로
 *     읽는 사본. 서비스 워커에서는 동적 import()가 스펙상 금지라
 *     (https://github.com/w3c/ServiceWorker/issues/1356) src/rules처럼 JS
 *     import 대상으로 둘 수 없다. rule-conditions는 네트워크 규칙 ID별
 *     condition + description 맵으로, 도메인별 "allow" 예외와 팝업의 차단
 *     규칙 레이블에 쓰인다.
 *
 * 원본 목록은 .cache/filter-sources/에 한 번 다운로드되어(gitignore 처리,
 * 필요할 때 다시 가져옴 — 용량이 크고 easylist.to가 표준 업스트림이라 커밋하지
 * 않음) 이후 빌드에서 재사용된다. 이는 빌드 타임 전용 가져오기이며, 확장
 * 프로그램 자체는 런타임에 규칙을 절대 가져오지 않는다 (번들됨).
 *
 * EasyList 문법 파싱과 DNR 변환 모두에 AdGuard가 관리하는 @adguard/tsurlfilter
 * 엔진(GPL-3.0, dev-dependency 전용, 빌드 타임에만 호출되며 번들/배포되거나
 * 런타임에 가져와지지 않음)을 사용한다. 이는 plan의 "직접 만든 파서 금지"
 * 원칙을 따른 것이다. EasyList/EasyPrivacy 콘텐츠 자체는 GPL-3.0 / CC-BY-SA-3.0
 * 이중 라이선스이며(https://easylist.to/pages/licence.html), 저작권 표시는 아래에 포함되어 있다.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CompatibilityTypes,
  CosmeticRule,
  FilterList,
  RuleFactory,
  setConfiguration,
} from "@adguard/tsurlfilter";
import { CosmeticRuleType } from "@adguard/agtree";
import { DeclarativeFilterConverter, Filter } from "@adguard/tsurlfilter/es/declarative-converter";

// Chrome의 declarativeNetRequest.Rule 형태 (ruleSet.getDeclarativeRules()가
// 반환하는 JSON과 일치한다). @adguard/tsurlfilter의 DeclarativeRule 타입이 이
// 패키지의 "exports" 맵 아래 해석 가능한 서브패스로 재수출되지 않으므로 여기서
// 직접 선언한다.
interface DeclarativeRule {
  id: number;
  priority?: number;
  action: Record<string, unknown>;
  condition: Record<string, unknown> & { regexFilter?: string; urlFilter?: string };
}

/**
 * 런타임에서 사용되는 규칙별 condition 레코드(src/rules/rule-conditions.json).
 * 최종적으로 전역 재할당된 네트워크 규칙 ID를 키로 한다. `description`은
 * 컨버터가 노출해주는 경우(ruleSet.getRulesById를 통해) 원본 EasyList/EasyPrivacy
 * 필터 라인이며, 그렇지 않으면 규칙 자신의 urlFilter/regexFilter 문자열이다.
 */
interface RuleCondition {
  regexFilter?: string;
  urlFilter?: string;
  description: string;
}

// Chrome MV3 정적 룰셋의 구체적인 상한선(declarativeNetRequest).
// https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#properties
// 30,000은 "확장 프로그램마다 경쟁 없이 보장되는 최소치"이지 전체 한도가
// 아니다. 이를 넘는 규칙은 브라우저 전체가 공유하는 전역 풀에서 가져오며,
// 실제 가용량은 런타임에 getAvailableStaticRuleCount()로만 알 수 있다.
// 그래서 변환은 최대한 많이 해두고, 보장분에 해당하는 룰셋만 켠 채로
// 배포한다. 나머지는 서비스 워커가 가용량을 보고 추가로 켠다.
const GUARANTEED_STATIC_RULES = 30_000;
// 변환 단계에서 허용할 총량. 원본 목록을 다 담고도 남을 만큼 잡되, 룰셋
// 파일 수가 MAX_STATIC_RULESETS를 넘지 않는 선에서 정한다.
const MAX_TOTAL_STATIC_RULES = 150_000;
const MAX_REGEX_FILTER_RULES = 1_000;
const MAX_STATIC_RULESETS = 100;
// 룰셋 하나가 켜고 끄는 단위다. 작을수록 전역 풀 가용량에 촘촘하게 맞출 수
// 있지만 파일 수가 늘어난다.
const RULES_PER_RULESET_FILE = 30_000;

const rootDir = path.resolve(import.meta.dirname, "..");
const sourcesDir = path.join(rootDir, ".cache", "filter-sources");
const rulesOutDir = path.join(rootDir, "src", "rules");
// 서비스 워커가 fetch(chrome.runtime.getURL(...))로 읽는 파일 출력 위치.
// 동적 import()를 못 쓰므로(위 헤더 주석 참고) Vite가 해시 없이 그대로
// 복사하는 public/ 아래 원본 파일로 둬야 한다.
const publicRulesOutDir = path.join(rootDir, "public", "rules");

// 우선순위 배분이 중요하다: EasyList(일반 광고 차단)가 주된 사용자 체감
// 신호이므로 3만 개 규칙 예산 중 더 큰 몫을 받고, EasyPrivacy(트래커 차단)가
// 나머지를 받는다. Chrome의 3만 개 활성-정적-규칙 상한선은 룰셋 파일별이
// 아니라 확장 프로그램의 *활성화된* 룰셋 전체를 합산해서 적용되므로 둘이
// 하나의 전역 예산을 공유한다.
const FILTER_SOURCES = [
  { id: 1, name: "EasyList", file: "easylist.txt", ruleBudgetShare: 0.6 },
  { id: 2, name: "EasyPrivacy", file: "easyprivacy.txt", ruleBudgetShare: 0.4 },
];

interface BuildStats {
  networkRulesConverted: number;
  networkRegexRules: number;
  networkRulesDropped: number;
  cosmeticSelectorsExtracted: number;
  cosmeticDomainsExtracted: number;
  cosmeticRulesSkipped: number;
}

async function loadFilterSourceText(fileName: string): Promise<string> {
  const filePath = path.join(sourcesDir, fileName);
  try {
    return await readFile(filePath, "utf8");
  } catch {
    const url = `https://easylist.to/easylist/${fileName}`;
    console.log(`[build-filter-rules] ${fileName} not cached locally, fetching from ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `[build-filter-rules] Failed to fetch ${url}: ${response.status} ${response.statusText}`,
      );
    }
    const text = await response.text();
    await mkdir(sourcesDir, { recursive: true });
    await writeFile(filePath, text, "utf8");
    return text;
  }
}

/**
 * 원본 필터 목록 텍스트에서 순수 CSS 요소 숨김 선택자(`##selector`)를 추출한다.
 * Extended-CSS, 스크립틀릿, JS, HTML 필터링 콘텐츠 규칙은 건너뛴다: MV3
 * 콘텐츠 스크립트는 Extended-CSS 런타임 없이 element.remove()/style을 통해
 * 순수 CSS 선택자만 안전하게 적용할 수 있다 (plan의 "최소한의 콘텐츠 스크립트
 * 런타임 부담" 원칙에 따라 범위 밖).
 */
function extractCosmeticSelectors(
  rawText: string,
  filterListId: number,
  stats: BuildStats,
): {
  selectors: { selector: string; genericOnly: boolean }[];
  domainSelectors: Map<string, Set<string>>;
} {
  const selectors = new Map<string, { selector: string; genericOnly: boolean }>();
  // EasyList의 `domain.com##selector` 형태에서 나온 도메인 → 선택자 목록.
  // 키에는 `amazon.*`처럼 TLD 자리에 와일드카드가 오는 형태가 섞여 있다.
  const domainSelectors = new Map<string, Set<string>>();
  const lines = rawText.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line || line.length === 0) continue;
    if (line.startsWith("!") || line.startsWith("[")) continue;

    let rule;
    try {
      rule = RuleFactory.createRule(line, filterListId, i, false, false);
    } catch {
      stats.cosmeticRulesSkipped += 1;
      continue;
    }
    if (!rule || !(rule instanceof CosmeticRule)) continue;

    if (rule.getType() !== CosmeticRuleType.ElementHidingRule) {
      stats.cosmeticRulesSkipped += 1;
      continue;
    }
    if (rule.isAllowlist() || rule.isExtendedCss()) {
      stats.cosmeticRulesSkipped += 1;
      continue;
    }

    const selector = rule.getContent().trim();
    if (!selector) continue;

    const existing = selectors.get(selector);
    const genericOnly = rule.isGeneric();
    if (!existing) {
      selectors.set(selector, { selector, genericOnly });
    } else if (existing.genericOnly && !genericOnly) {
      existing.genericOnly = false;
    }

    for (const domain of rule.getPermittedDomains() ?? []) {
      let set = domainSelectors.get(domain);
      if (!set) domainSelectors.set(domain, (set = new Set()));
      set.add(selector);
    }
  }

  return { selectors: Array.from(selectors.values()), domainSelectors };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function main() {
  await mkdir(rulesOutDir, { recursive: true });
  await mkdir(publicRulesOutDir, { recursive: true });

  setConfiguration({
    engine: "extension",
    version: "3",
    verbose: false,
    compatibility: CompatibilityTypes.Extension,
  });

  const stats: BuildStats = {
    networkRulesConverted: 0,
    networkRegexRules: 0,
    networkRulesDropped: 0,
    cosmeticSelectorsExtracted: 0,
    cosmeticDomainsExtracted: 0,
    cosmeticRulesSkipped: 0,
  };

  const converter = new DeclarativeFilterConverter();
  const allDeclarativeRules: DeclarativeRule[] = [];
  // allDeclarativeRules와 나란히 대응됨: 원본 EasyList 필터 라인 텍스트
  // (또는 컨버터가 해당 id에 대해 소스 규칙을 노출하지 않았다면 undefined).
  const sourceRuleText: (string | undefined)[] = [];
  const cosmeticSelectorSet = new Map<string, { selector: string; genericOnly: boolean }>();
  const domainCosmeticSelectors = new Map<string, Set<string>>();

  for (const source of FILTER_SOURCES) {
    const rawText = await loadFilterSourceText(source.file);
    console.log(`[build-filter-rules] Loaded ${source.name}: ${rawText.split("\n").length} lines`);

    const filter = new Filter(
      source.id,
      { getContent: () => Promise.resolve(new FilterList(rawText)) },
      true,
    );

    const sourceRuleBudget = Math.floor(MAX_TOTAL_STATIC_RULES * source.ruleBudgetShare);
    const sourceRegexBudget = Math.floor(MAX_REGEX_FILTER_RULES * source.ruleBudgetShare);

    const { ruleSet, limitations } = await converter.convertStaticRuleSet(filter, {
      resourcesPath: "/war",
      maxNumberOfRules: sourceRuleBudget,
      maxNumberOfRegexpRules: sourceRegexBudget,
    });

    const declarativeRules = await ruleSet.getDeclarativeRules();
    // 사람이 읽을 수 있는 설명을 위해 생성된 각 규칙을 원본 EasyList 필터
    // 라인으로 다시 연결한다. getRulesById는 컨버터 자체의 (재할당 전) 규칙
    // id를 받아서 그것을 만들어낸 소스 규칙들을 반환한다; 해당 id에 대한
    // 소스 맵이 없으면 undefined로 대체한다 (나중에 → urlFilter/regexFilter 문자열).
    for (const rule of declarativeRules) {
      let originalLine: string | undefined;
      try {
        const sources = await ruleSet.getRulesById(rule.id);
        originalLine = sources.map((s) => s.sourceRule).find((s) => s && s.length > 0);
      } catch {
        originalLine = undefined;
      }
      sourceRuleText.push(originalLine);
    }
    allDeclarativeRules.push(...declarativeRules);
    stats.networkRulesConverted += ruleSet.getRulesCount();
    stats.networkRegexRules += ruleSet.getRegexpRulesCount();

    if (limitations.length > 0) {
      console.warn(
        `[build-filter-rules] WARNING: ${source.name} conversion hit limits and was reduced:\n` +
          limitations.map((l) => `  - ${l.message ?? String(l)}`).join("\n"),
      );
      stats.networkRulesDropped += limitations.length;
    }

    const cosmetic = extractCosmeticSelectors(rawText, source.id, stats);
    for (const entry of cosmetic.selectors) {
      const existing = cosmeticSelectorSet.get(entry.selector);
      if (!existing) {
        cosmeticSelectorSet.set(entry.selector, entry);
      } else if (existing.genericOnly && !entry.genericOnly) {
        existing.genericOnly = false;
      }
    }
    for (const [domain, set] of cosmetic.domainSelectors) {
      let merged = domainCosmeticSelectors.get(domain);
      if (!merged) domainCosmeticSelectors.set(domain, (merged = new Set()));
      for (const selector of set) merged.add(selector);
    }
  }

  // 통합된 규칙 집합 전체에 전역적으로 고유한 순차 id를 다시 부여한다
  // (각 소스 필터의 DeclarativeFilterConverter는 id를 1부터 시작하므로,
  // 하나의 manifest 룰셋 등록으로 병합되면 충돌하게 된다).
  const combinedRules = allDeclarativeRules.map((rule, index) => Object.assign(rule, { id: index + 1 }));

  // 최종(재할당된) id를 키로 하는 런타임 rule-conditions 맵을 만든다.
  // sourceRuleText는 allDeclarativeRules와 순서가 나란히 대응되며(재할당 전
  // 순서), combinedRules도 이를 그대로 유지한다 — 둘 다에서 인덱스 i는 같은
  // 규칙을 가리킨다.
  const ruleConditions: Record<number, RuleCondition> = {};
  combinedRules.forEach((rule, index) => {
    const regexFilter = rule.condition.regexFilter;
    const urlFilter = rule.condition.urlFilter;
    const source = sourceRuleText[index];
    const description = source ?? regexFilter ?? urlFilter ?? "";
    const condition: RuleCondition = { description };
    if (regexFilter) condition.regexFilter = regexFilter;
    if (urlFilter) condition.urlFilter = urlFilter;
    ruleConditions[rule.id] = condition;
  });

  // --- 상한선 검증: 조용히 잘라내지 않고 빌드를 요란하게 실패시킨다. ---
  const totalRuleCount = combinedRules.length;
  const totalRegexRuleCount = combinedRules.filter((r) => Boolean(r.condition.regexFilter)).length;

  if (totalRuleCount > MAX_TOTAL_STATIC_RULES) {
    console.error(
      `[build-filter-rules] FATAL: ${totalRuleCount} combined network rules exceed the ` +
        `${MAX_TOTAL_STATIC_RULES} build budget. Build failed.`,
    );
    process.exit(1);
  }
  if (totalRegexRuleCount > MAX_REGEX_FILTER_RULES) {
    console.error(
      `[build-filter-rules] FATAL: ${totalRegexRuleCount} regexFilter rules exceed Chrome's ` +
        `${MAX_REGEX_FILTER_RULES}-regexFilter-rule cap. Build failed.`,
    );
    process.exit(1);
  }

  const rulesetChunks = chunk(combinedRules, RULES_PER_RULESET_FILE);

  if (rulesetChunks.length > MAX_STATIC_RULESETS) {
    console.error(
      `[build-filter-rules] FATAL: ${rulesetChunks.length} ruleset files exceed Chrome's ` +
        `${MAX_STATIC_RULESETS}-static-ruleset cap. Build failed.`,
    );
    process.exit(1);
  }

  // 보장 최소치를 넘지 않는 선까지의 룰셋만 매니페스트에서 켠 채로 배포한다.
  // 이보다 많이 켠 상태로 설치되면, 전역 풀이 이미 다른 확장 프로그램으로
  // 차 있을 때 Chrome이 룰셋 로드를 거부해 차단이 통째로 죽는다.
  const coreRulesetCount = Math.floor(GUARANTEED_STATIC_RULES / RULES_PER_RULESET_FILE);
  const rulesetRuleCounts = rulesetChunks.map((rules) => rules.length);

  await Promise.all(
    rulesetChunks.map((rules, index) =>
      writeFile(path.join(rulesOutDir, `dnr-ruleset-${index + 1}.json`), `${JSON.stringify(rules)}\n`, "utf8"),
    ),
  );

  const cosmeticSelectors = Array.from(cosmeticSelectorSet.values())
    .filter((entry) => entry.genericOnly)
    .map((entry) => entry.selector)
    .sort();
  const cosmeticSelectorsJson = `${JSON.stringify(cosmeticSelectors, null, 2)}\n`;
  // options/콘텐츠 스크립트는 src/rules에서 import하고, 서비스 워커(filter-update.ts)는
  // public/rules 사본을 fetch()로 읽는다.
  await Promise.all([
    writeFile(path.join(rulesOutDir, "cosmetic-selectors.json"), cosmeticSelectorsJson, "utf8"),
    writeFile(path.join(publicRulesOutDir, "cosmetic-selectors.json"), cosmeticSelectorsJson, "utf8"),
  ]);
  stats.cosmeticSelectorsExtracted = cosmeticSelectors.length;

  // 콘텐츠 스크립트가 그대로 <style>에 넣는 완성된 스타일시트. 선택자마다
  // 규칙을 따로 뽑으면 선언부만 32만 바이트 넘게 중복되고, 전부를 한 규칙으로
  // 합치면 CSS 파서가 잘못된 선택자 하나 때문에 필터 전체를 버린다. 묶음으로
  // 나눠 손실을 그 묶음 하나로 제한한다.
  const CSS_SELECTORS_PER_RULE = 64;
  const cssRules: string[] = [];
  for (let i = 0; i < cosmeticSelectors.length; i += CSS_SELECTORS_PER_RULE) {
    const group = cosmeticSelectors.slice(i, i + CSS_SELECTORS_PER_RULE);
    cssRules.push(`${group.join(",")}{display:none!important}`);
  }
  await writeFile(path.join(rulesOutDir, "cosmetic.css"), `${cssRules.join("\n")}\n`, "utf8");

  // 도메인 특화 선택자. 범용 스타일시트와 달리 콘텐츠 스크립트에 통째로 넣지
  // 않는다 — 500KB가 넘어 프레임마다 파싱하면 감당이 안 된다. 서비스 워커가
  // 한 번만 읽어 들고 있다가 호스트명별로 조회해준다(public/rules에서 fetch).
  const domainCosmetics: Record<string, string[]> = {};
  for (const [domain, set] of [...domainCosmeticSelectors].sort(([a], [b]) => a.localeCompare(b))) {
    domainCosmetics[domain] = [...set].sort();
  }
  await writeFile(
    path.join(publicRulesOutDir, "cosmetic-domains.json"),
    `${JSON.stringify(domainCosmetics)}\n`,
    "utf8",
  );
  stats.cosmeticDomainsExtracted = domainCosmeticSelectors.size;

  // 규칙 ID → 조건/설명 맵. 전량이 9MB에 달해 통째로 올리면 팝업이 열리지
  // 않으므로 룰셋과 같은 경계로 쪼갠다. 규칙 ID가 순번이므로 조회 측은
  // ID만으로 어느 조각을 읽어야 하는지 계산할 수 있다(public/rules에서 fetch).
  await Promise.all(
    rulesetChunks.map((rules, index) => {
      const chunkConditions: Record<number, RuleCondition> = {};
      for (const rule of rules) {
        const condition = ruleConditions[rule.id];
        if (condition) chunkConditions[rule.id] = condition;
      }
      return writeFile(
        path.join(publicRulesOutDir, `rule-conditions-${index + 1}.json`),
        `${JSON.stringify(chunkConditions)}\n`,
        "utf8",
      );
    }),
  );

  const manifestMeta = {
    generatedAt: new Date().toISOString(),
    sources: FILTER_SOURCES.map((s) => s.name),
    attribution: "EasyList & EasyPrivacy (https://easylist.to/) — dual GPL-3.0 / CC-BY-SA-3.0 licensed",
    rulesetFileCount: rulesetChunks.length,
    // 매니페스트에서 기본으로 켤 룰셋 수. 나머지는 서비스 워커가 전역 풀
    // 가용량을 확인한 뒤 추가로 켠다.
    coreRulesetCount,
    // 룰셋별 규칙 수 — 워커가 "이 룰셋을 켤 예산이 남았는지" 계산하는 데 쓴다.
    rulesetRuleCounts,
    // 규칙 ID로 rule-conditions 조각 번호를 계산하는 데 쓴다.
    rulesPerRulesetFile: RULES_PER_RULESET_FILE,
    ...stats,
    totalNetworkRules: totalRuleCount,
    coreNetworkRules: rulesetRuleCounts.slice(0, coreRulesetCount).reduce((a, b) => a + b, 0),
    totalRegexFilterRules: totalRegexRuleCount,
    caps: {
      guaranteedStaticRules: GUARANTEED_STATIC_RULES,
      maxRegexFilterRules: MAX_REGEX_FILTER_RULES,
      maxStaticRulesets: MAX_STATIC_RULESETS,
    },
  };
  await writeFile(
    path.join(rulesOutDir, "filter-metadata.json"),
    `${JSON.stringify(manifestMeta, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `[build-filter-rules] Done. Network rules: ${totalRuleCount} in ${rulesetChunks.length} ruleset(s) ` +
      `— ${coreRulesetCount} enabled by default (guaranteed ${GUARANTEED_STATIC_RULES}), ` +
      `${rulesetChunks.length - coreRulesetCount} enabled at runtime from the global pool. ` +
      `Regex: ${totalRegexRuleCount}/${MAX_REGEX_FILTER_RULES}. ` +
      `Cosmetic selectors: ${cosmeticSelectors.length} generic, ` +
      `${domainCosmeticSelectors.size} domain-specific entries.`,
  );
}

main().catch((err) => {
  console.error("[build-filter-rules] FATAL:", err);
  process.exit(1);
});
