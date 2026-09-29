// 필터 목록의 AdGuard 전처리 지시문(`!#if` / `!#else` / `!#endif`)을 크롬 MV3
// 확장 프로그램 기준으로 평가해 해당하지 않는 블록을 걷어낸다.
// https://adguard.com/kb/general/ad-filtering/create-own-filters/#conditions-directive
//
// List-KR처럼 여러 플랫폼용 규칙을 한 파일에 담은 목록은 iOS·Safari·데스크톱
// 앱 전용 블록을 조건부로 감싸 둔다. 지시문은 `!`로 시작해 주석처럼 보이므로
// 그대로 변환기에 넘기면 모든 분기의 규칙이 한꺼번에 들어간다.

// 이 확장 프로그램이 해당하는 플랫폼 상수. 나머지 상수는 모두 거짓으로 본다.
const CHROMIUM_MV3_CONSTANTS: ReadonlySet<string> = new Set([
  "adguard",
  "adguard_ext_chromium",
  "adguard_ext_chromium_mv3",
]);

/** `!`, `&&`, `||`, 괄호로 이뤄진 조건식을 평가한다. */
export function evaluateCondition(expression: string, truthy: ReadonlySet<string> = CHROMIUM_MV3_CONSTANTS): boolean {
  const tokens = expression.match(/[A-Za-z_][A-Za-z0-9_]*|&&|\|\||[!()]/g) ?? [];
  let index = 0;

  const fail = (): never => {
    throw new Error(`잘못된 조건식: ${expression}`);
  };
  const parseOr = (): boolean => {
    let value = parseAnd();
    while (tokens[index] === "||") {
      index += 1;
      const right = parseAnd();
      value = value || right;
    }
    return value;
  };
  const parseAnd = (): boolean => {
    let value = parseUnary();
    while (tokens[index] === "&&") {
      index += 1;
      const right = parseUnary();
      value = value && right;
    }
    return value;
  };
  const parseUnary = (): boolean => {
    const token = tokens[index++];
    if (token === "!") return !parseUnary();
    if (token === "(") {
      const value = parseOr();
      if (tokens[index++] !== ")") fail();
      return value;
    }
    if (token === undefined || token === ")" || token === "&&" || token === "||") fail();
    return truthy.has(token as string);
  };

  const result = parseOr();
  if (index !== tokens.length) fail();
  return result;
}

/** 조건에 맞지 않는 블록과 지시문 줄 자체를 제거한 목록 텍스트를 돌려준다. */
export function preprocessFilterList(text: string, truthy: ReadonlySet<string> = CHROMIUM_MV3_CONSTANTS): string {
  // 블록마다 "이 분기가 선택됐는지"를 쌓는다. 바깥 블록이 하나라도 거짓이면 안쪽은 모두 버린다.
  const branches: boolean[] = [];
  const output: string[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("!#if ") || trimmed.startsWith("!#if(")) {
      branches.push(evaluateCondition(trimmed.slice("!#if".length), truthy));
    } else if (trimmed === "!#else") {
      if (branches.length === 0) throw new Error("짝이 없는 !#else");
      branches[branches.length - 1] = !branches[branches.length - 1];
    } else if (trimmed === "!#endif") {
      if (branches.pop() === undefined) throw new Error("짝이 없는 !#endif");
    } else if (branches.every(Boolean)) {
      output.push(line);
    }
  }

  if (branches.length > 0) throw new Error(`닫히지 않은 !#if ${branches.length}개`);
  return output.join("\n");
}
