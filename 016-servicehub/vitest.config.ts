import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/integration/global-setup.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
    // 統合テストは同じテストDBを使うためファイル単位で直列実行
    fileParallelism: false,
    pool: 'forks',
  },
});
