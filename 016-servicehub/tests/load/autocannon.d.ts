// autocannon には型定義がないため、測定スクリプトで使う範囲だけ宣言する
declare module 'autocannon' {
  interface Histogram {
    average: number;
    p50: number;
    p90: number;
    p99: number;
    max: number;
  }
  interface Result {
    latency: Histogram;
    requests: Histogram;
    errors: number;
    non2xx: number;
  }
  function autocannon(opts: { url: string; connections?: number; duration?: number; headers?: Record<string, string> }): Promise<Result>;
  export default autocannon;
}
