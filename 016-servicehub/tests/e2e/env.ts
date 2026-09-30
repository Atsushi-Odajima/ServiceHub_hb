/** E2E の接続先・固定アカウント(E2E 専用DB・ローカルのみ) */
const port = Number(process.env.E2E_PORT ?? 3200);
export const E2E = {
  port,
  baseUrl: `http://localhost:${port}`,
  databaseUrl: process.env.E2E_DATABASE_URL ?? 'postgres://servicehub:servicehub_dev_pw@127.0.0.1:5432/servicehub_e2e',
  sessionSecret: 'e2e-session-secret-0123456789abcdefghijklmnopqrstuvwxyz',
  orgSlug: 'e2e-studio',
  ownerEmail: 'owner@e2e-studio.example',
  password: 'e2e-password-2026',
  sample: {
    slug: 'sample-wellness',
    password: 'sample-pass-2026',
    owner: 'owner@sample-wellness.example',
    manager: 'manager@sample-wellness.example',
    reception: 'reception@sample-wellness.example',
    aki: 'aki@sample-wellness.example',
    ken: 'ken@sample-wellness.example',
  },
};
