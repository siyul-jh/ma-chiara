/**
 * 빌드 타임 필터 파이프라인: EasyList + EasyPrivacy를 다음으로 변환한다:
 *   - src/rules/dnr-ruleset-*.json — 정적 declarativeNetRequest 룰셋
 *   - src/rules/cosmetic-selectors.json — 콘텐츠 스크립트의 DOM 숨김용 CSS 선택자
 *   - src/rules/rule-conditions.json — 네트워크 규칙 ID별 condition + description
 *     맵. 런타임에 도메인별 "allow" 예외를 만들고, 팝업에서 발견된 차단 규칙에
 *     원본 EasyList 필터 라인으로 레이블을 붙이는 데 쓰인다.
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
const MAX_ENABLED_STATIC_RULES = 30_000;
const MAX_REGEX_FILTER_RULES = 1_000;
// 각 룰셋 파일이 단일 룰셋의 실용적인 크기보다 충분히 작게 유지되면서도
// 활성화된 전체 합계가 상한선 아래를 유지하도록, 큰 룰셋을 청크로 나눈다.
const RULES_PER_RULESET_FILE = 5_000;

const rootDir = path.resolve(import.meta.dirname, "..");
const sourcesDir = path.join(rootDir, ".cache", "filter-sources");
const rulesOutDir = path.join(rootDir, "src", "rules");

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
): { selector: string; genericOnly: boolean }[] {
  const selectors = new Map<string, { selector: string; genericOnly: boolean }>();
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
  }

  return Array.from(selectors.values());
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
    cosmeticRulesSkipped: 0,
  };

  const converter = new DeclarativeFilterConverter();
  const allDeclarativeRules: DeclarativeRule[] = [];
  // allDeclarativeRules와 나란히 대응됨: 원본 EasyList 필터 라인 텍스트
  // (또는 컨버터가 해당 id에 대해 소스 규칙을 노출하지 않았다면 undefined).
  const sourceRuleText: (string | undefined)[] = [];
  const cosmeticSelectorSet = new Map<string, { selector: string; genericOnly: boolean }>();

  for (const source of FILTER_SOURCES) {
    const rawText = await loadFilterSourceText(source.file);
    console.log(`[build-filter-rules] Loaded ${source.name}: ${rawText.split("\n").length} lines`);

    const filter = new Filter(
      source.id,
      { getContent: () => Promise.resolve(new FilterList(rawText)) },
      true,
    );

    const sourceRuleBudget = Math.floor(MAX_ENABLED_STATIC_RULES * source.ruleBudgetShare);
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
      let source: string | undefined;
      try {
        const sources = await ruleSet.getRulesById(rule.id);
        source = sources.map((s) => s.sourceRule).find((s) => s && s.length > 0);
      } catch {
        source = undefined;
      }
      sourceRuleText.push(source);
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

    const cosmeticSelectors = extractCosmeticSelectors(rawText, source.id, stats);
    for (const entry of cosmeticSelectors) {
      const existing = cosmeticSelectorSet.get(entry.selector);
      if (!existing) {
        cosmeticSelectorSet.set(entry.selector, entry);
      } else if (existing.genericOnly && !entry.genericOnly) {
        existing.genericOnly = false;
      }
    }
  }

  // 통합된 규칙 집합 전체에 전역적으로 고유한 순차 id를 다시 부여한다
  // (각 소스 필터의 DeclarativeFilterConverter는 id를 1부터 시작하므로,
  // 하나의 manifest 룰셋 등록으로 병합되면 충돌하게 된다).
  const combinedRules = allDeclarativeRules.map((rule, index) => ({ ...rule, id: index + 1 }));

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

  if (totalRuleCount > MAX_ENABLED_STATIC_RULES) {
    console.error(
      `[build-filter-rules] FATAL: ${totalRuleCount} combined network rules exceed Chrome's ` +
        `${MAX_ENABLED_STATIC_RULES}-enabled-static-rule cap. Build failed.`,
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
  await Promise.all(
    rulesetChunks.map((rules, index) =>
      writeFile(path.join(rulesOutDir, `dnr-ruleset-${index + 1}.json`), `${JSON.stringify(rules, null, 2)}\n`, "utf8"),
    ),
  );

  const cosmeticSelectors = Array.from(cosmeticSelectorSet.values())
    .filter((entry) => entry.genericOnly)
    .map((entry) => entry.selector)
    .sort();
  await writeFile(
    path.join(rulesOutDir, "cosmetic-selectors.json"),
    `${JSON.stringify(cosmeticSelectors, null, 2)}\n`,
    "utf8",
  );
  stats.cosmeticSelectorsExtracted = cosmeticSelectors.length;

  await writeFile(
    path.join(rulesOutDir, "rule-conditions.json"),
    `${JSON.stringify(ruleConditions)}\n`,
    "utf8",
  );

  const manifestMeta = {
    generatedAt: new Date().toISOString(),
    sources: FILTER_SOURCES.map((s) => s.name),
    attribution: "EasyList & EasyPrivacy (https://easylist.to/) — dual GPL-3.0 / CC-BY-SA-3.0 licensed",
    rulesetFileCount: rulesetChunks.length,
    ...stats,
    totalNetworkRules: totalRuleCount,
    totalRegexFilterRules: totalRegexRuleCount,
    caps: { maxEnabledStaticRules: MAX_ENABLED_STATIC_RULES, maxRegexFilterRules: MAX_REGEX_FILTER_RULES },
  };
  await writeFile(
    path.join(rulesOutDir, "filter-metadata.json"),
    `${JSON.stringify(manifestMeta, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `[build-filter-rules] Done. Network rules: ${totalRuleCount}/${MAX_ENABLED_STATIC_RULES} ` +
      `(regex: ${totalRegexRuleCount}/${MAX_REGEX_FILTER_RULES}), split into ${rulesetChunks.length} ruleset file(s). ` +
      `Cosmetic selectors: ${cosmeticSelectors.length}.`,
  );
}

main().catch((err) => {
  console.error("[build-filter-rules] FATAL:", err);
  process.exit(1);
});
