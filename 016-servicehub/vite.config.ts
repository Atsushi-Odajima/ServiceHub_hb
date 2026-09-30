import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// PWA: アプリシェルのプリキャッシュ + 「今日の予定/受付ボード」の閲覧キャッシュのみ。
// 予約確定・変更・来店/完了・回数券消化などの更新系はキャッシュ/キューイングしない(オンライン必須)。
export default defineConfig({
  root: 'src/web',
  publicDir: '../../public',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['favicon-32.png', 'apple-touch-icon.png', 'icon.svg'],
      manifest: {
        name: 'ServiceHub',
        short_name: 'ServiceHub',
        description: '予約・顧客・スタッフ・拠点・受付・回数券をまとめて管理するサービス事業の運営システム',
        lang: 'ja',
        start_url: '/app',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f6f8f9',
        theme_color: '#0f5f73',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/healthz/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // 閲覧専用の当日データのみ(GET)。オフライン時は最終取得分を「オフライン表示」として出す。
            // ログイン情報(auth/me)も含めないと、通信が切れた状態で開き直したときに画面を表示できない。
            // ログイン・ログアウト・組織の切替時に画面側でこのキャッシュを消す(共有端末で前の利用者の情報を出さない)
            urlPattern: ({ url, request }) =>
              request.method === 'GET' &&
              ['/api/v1/auth/me', '/api/v1/today', '/api/v1/reception/board', '/api/v1/dashboard'].includes(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'sh-offline-read',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 30, maxAgeSeconds: 12 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
});
