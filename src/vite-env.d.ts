// tsconfig의 types가 ["chrome"]으로 제한되어 vite/client가 들어오지 않으므로
// 쓰는 형태만 직접 선언한다.

declare module "*.css?raw" {
  const content: string;
  export default content;
}
