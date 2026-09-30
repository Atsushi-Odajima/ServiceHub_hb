import pg from 'pg';

export interface ChangeEvent {
  o: string; // organization
  l: string | null; // location
  e: string; // entity
  i: string; // id
}

type Listener = (ev: ChangeEvent) => void;

/**
 * PostgreSQL LISTEN/NOTIFY を購読し、SSE 接続へ配信する(複数インスタンスでも全インスタンスに届く)。
 * 業務トランザクション内の pg_notify はコミット時にのみ配信されるため、確定した変更だけが通知される。
 * 通知内容は ID のみ(個人情報を含めない)。受信側は再取得して権限に応じたデータを得る。
 */
export class RealtimeHub {
  private client: pg.Client | null = null;
  private listeners = new Set<Listener>();
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly connectionString: string, private readonly ssl?: pg.ClientConfig['ssl']) {}

  async start(): Promise<void> {
    if (this.stopped) return;
    const c = new pg.Client({ connectionString: this.connectionString, ssl: this.ssl, application_name: 'servicehub-realtime' });
    c.on('notification', (msg) => {
      if (msg.channel !== 'sh_events' || !msg.payload) return;
      try {
        const ev = JSON.parse(msg.payload) as ChangeEvent;
        for (const l of this.listeners) l(ev);
      } catch {
        /* ignore malformed */
      }
    });
    c.on('error', () => this.reconnect());
    c.on('end', () => this.reconnect());
    try {
      await c.connect();
      await c.query('LISTEN sh_events');
      this.client = c;
    } catch {
      this.reconnect();
    }
  }

  private reconnect(): void {
    if (this.stopped || this.retry) return;
    const old = this.client;
    this.client = null;
    old?.end().catch(() => undefined);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.start();
    }, 5000);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get connections(): number {
    return this.listeners.size;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    await this.client?.end().catch(() => undefined);
  }
}
