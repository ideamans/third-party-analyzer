import { defineConfig } from 'vitest/config'

// 実際に Chrome と Lighthouse を動かすスモークテスト。単体テスト（npm test）とは分け、
// `npm run test:smoke` で走らせる。1 回の計測に数十秒かかる。
export default defineConfig({
  test: {
    include: ['test/smoke/**/*.smoke.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
