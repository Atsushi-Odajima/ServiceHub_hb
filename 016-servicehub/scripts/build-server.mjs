// サーバー/CLI を dist/server へバンドル(依存パッケージは外部参照のまま)
import { build } from 'esbuild';
import { existsSync } from 'node:fs';

const entries = [
  'src/server/index.ts',
  'src/server/worker.ts',
  'src/server/cli/migrate.ts',
  'src/server/cli/setup-org.ts',
  'src/server/cli/seed-sample.ts',
  'src/server/cli/backup.ts',
  'src/server/cli/reset-password.ts',
].filter((f) => existsSync(f));

await build({
  entryPoints: entries,
  outdir: 'dist/server',
  outbase: 'src/server',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
