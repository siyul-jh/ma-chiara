import { defineConfig } from "vitest/config";

// vite.config.ts를 그대로 쓰면 테스트를 돌릴 때마다 확장 프로그램 빌드
// 플러그인(crxjs)까지 함께 로드된다. 순수 함수 단위 테스트에는 필요 없으므로
// 설정을 분리한다.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
