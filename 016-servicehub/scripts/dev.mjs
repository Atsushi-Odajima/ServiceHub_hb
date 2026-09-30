// 開発用: API(tsx watch) と Vite を同時起動
import { spawn } from 'node:child_process';

const env = { ...process.env, EXTRA_ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173' };
const procs = [
  spawn('pnpm', ['dev:server'], { stdio: 'inherit', env }),
  spawn('pnpm', ['dev:web'], { stdio: 'inherit', env }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
