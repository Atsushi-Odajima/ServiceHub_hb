/**
 * バックアップファイル形式
 *
 *   平文:   gzip( NDJSON )
 *   暗号化: "SHBKENC1"(8) + salt(16) + iv(12) + AES-256-GCM( gzip( NDJSON ) ) + tag(16)
 *           鍵は BACKUP_ENCRYPTION_KEY(パスフレーズ)から scrypt で導出する。
 *
 * NDJSON の各行:
 *   {"type":"header", format, formatVersion, schemaVersion, appVersion, createdAt, organization, tables, ...}
 *   {"type":"table", name, columns, types}      表の開始
 *   ["値", null, ...]                              行(各列は PostgreSQL のテキスト表現。NULL は null)
 *   {"type":"end", name, count, sha256}          表の終了(行の件数とハッシュ)
 *   {"type":"footer", counts, lines, sha256}     全行(footer 以外)の SHA-256
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, type DecipherGCM } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { once } from 'node:events';
import { pipeline, Transform, type TransformCallback, type Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip, createGzip } from 'node:zlib';

export const ENC_MAGIC = Buffer.from('SHBKENC1', 'ascii');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const PREAMBLE_LEN = ENC_MAGIC.length + SALT_LEN + IV_LEN;
/** 1行の上限(CSV取込履歴の行データなど大きな JSON を含む列があるため余裕を持たせる) */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface BackupOrganizationInfo {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  isSample: boolean;
}

export interface BackupHeader {
  type: 'header';
  format: string;
  formatVersion: number;
  schemaVersion: string;
  appVersion: string;
  createdAt: string;
  organization: BackupOrganizationInfo;
  tables: string[];
  excludedTables: string[];
  /** SESSION_SECRET の指紋(値そのものではない)。復元先で異なる場合に警告する */
  secretFingerprint: string | null;
}

export interface TableStartLine {
  type: 'table';
  name: string;
  columns: string[];
  types: string[];
}

export interface TableEndLine {
  type: 'end';
  name: string;
  count: number;
  sha256: string;
}

export interface BackupFooter {
  type: 'footer';
  counts: Record<string, number>;
  lines: number;
  sha256: string;
}

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** SESSION_SECRET の指紋(HMAC。元の値は復元できない) */
export function secretFingerprint(secret: string | undefined | null): string | null {
  if (!secret) return null;
  return createHmac('sha256', secret).update('servicehub:backup-fingerprint:v1').digest('hex').slice(0, 16);
}

export function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export function validateEncryptionKey(passphrase: string | undefined | null): string | null {
  if (!passphrase) return null;
  if (passphrase.length < 16) throw new BackupFormatError('BACKUP_ENCRYPTION_KEY は16文字以上にしてください');
  return passphrase;
}

/** 暗号化: 先頭に magic + salt + iv、末尾に認証タグを付ける */
export async function createEncryptStream(passphrase: string): Promise<Transform> {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let started = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      if (!started) {
        this.push(Buffer.concat([ENC_MAGIC, salt, iv]));
        started = true;
      }
      cb(null, cipher.update(chunk));
    },
    flush(cb: TransformCallback) {
      if (!started) this.push(Buffer.concat([ENC_MAGIC, salt, iv]));
      this.push(cipher.final());
      cb(null, cipher.getAuthTag());
    },
  });
}

/**
 * 復号: 末尾16バイト(認証タグ)を保留しながら復号する。
 * 改ざん・鍵違いは最後に例外になる(復元はその時点で全体を巻き戻す)。
 */
export function createDecryptStream(passphrase: string): Transform {
  let head: Buffer = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  let tail: Buffer = Buffer.alloc(0);
  const feed = (self: Transform, data: Buffer) => {
    const all = tail.length ? Buffer.concat([tail, data]) : data;
    if (all.length <= TAG_LEN) {
      tail = all;
      return;
    }
    tail = all.subarray(all.length - TAG_LEN);
    const out = decipher!.update(all.subarray(0, all.length - TAG_LEN));
    if (out.length) self.push(out);
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      if (decipher) {
        try {
          feed(this, chunk);
          cb();
        } catch (e) {
          cb(e as Error);
        }
        return;
      }
      head = Buffer.concat([head, chunk]);
      if (head.length < PREAMBLE_LEN) return cb();
      if (!head.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) return cb(new BackupFormatError('暗号化バックアップの形式ではありません'));
      const salt = head.subarray(ENC_MAGIC.length, ENC_MAGIC.length + SALT_LEN);
      const iv = head.subarray(ENC_MAGIC.length + SALT_LEN, PREAMBLE_LEN);
      const rest = head.subarray(PREAMBLE_LEN);
      deriveKey(passphrase, Buffer.from(salt))
        .then((key) => {
          decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv)) as DecipherGCM;
          if (rest.length) feed(this, Buffer.from(rest));
          cb();
        })
        .catch((e) => cb(e as Error));
    },
    flush(cb: TransformCallback) {
      if (!decipher || tail.length !== TAG_LEN) return cb(new BackupFormatError('暗号化バックアップが途中で切れています'));
      try {
        decipher.setAuthTag(tail);
        const out = decipher.final();
        cb(null, out);
      } catch {
        cb(new BackupFormatError('復号できません(暗号化キーが違うか、ファイルが改ざん・破損しています)'));
      }
    },
  });
}

/** バックアップの書き出し: 行ごとに全体ハッシュを更新しつつ gzip(+暗号化)して出力する */
export class BackupWriter {
  private readonly gzip = createGzip({ level: 6 });
  private readonly hash = createHash('sha256');
  private readonly done: Promise<void>;
  private failed: Error | null = null;
  lines = 0;

  constructor(out: Writable, encrypt: Transform | null) {
    this.done = new Promise((resolve, reject) => {
      const onEnd = (err?: Error | null) => {
        if (err) {
          this.failed = err;
          reject(err);
        } else resolve();
      };
      if (encrypt) pipeline(this.gzip, encrypt, out, onEnd);
      else pipeline(this.gzip, out, onEnd);
    });
    // 未処理の reject にしない(finish で待つ)
    this.done.catch(() => undefined);
  }

  /** footer 以外の行(全体ハッシュの対象) */
  async line(text: string): Promise<void> {
    this.hash.update(text);
    this.hash.update('\n');
    this.lines++;
    await this.raw(text + '\n');
  }

  /** 改行で終わる複数行をまとめて書く(全体ハッシュの対象) */
  async batch(text: string, lineCount: number): Promise<void> {
    this.hash.update(text);
    this.lines += lineCount;
    await this.raw(text);
  }

  digest(): string {
    return this.hash.digest('hex');
  }

  async raw(text: string): Promise<void> {
    if (this.failed) throw this.failed;
    if (!this.gzip.write(text)) await once(this.gzip, 'drain');
  }

  async finish(): Promise<void> {
    this.gzip.end();
    await this.done;
  }

  abort(err: Error): void {
    this.gzip.destroy(err);
  }
}

/** ファイル先頭を見て暗号化の有無を判定する */
export async function detectBackupFile(file: string): Promise<'encrypted' | 'gzip'> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(ENC_MAGIC.length);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead >= ENC_MAGIC.length && buf.equals(ENC_MAGIC)) return 'encrypted';
    if (bytesRead >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip';
  } finally {
    await fh.close();
  }
  throw new BackupFormatError('ServiceHub のバックアップファイルではありません');
}

export interface OpenedBackup {
  encrypted: boolean;
  lines: AsyncGenerator<string>;
}

/**
 * バックアップファイルを1行ずつ読む(復号・展開はストリームで行い、全体をメモリに載せない)。
 * maxBytes: 展開後の上限(圧縮爆弾対策)。
 */
export async function openBackup(file: string, opts: { encryptionKey?: string | null; maxBytes?: number } = {}): Promise<OpenedBackup> {
  const kind = await detectBackupFile(file);
  if (kind === 'encrypted' && !opts.encryptionKey) {
    throw new BackupFormatError('暗号化されたバックアップです。作成時と同じ BACKUP_ENCRYPTION_KEY を設定してください');
  }
  const src = createReadStream(file);
  const gunzip = createGunzip();
  const onError = () => undefined;
  const last =
    kind === 'encrypted'
      ? pipeline(src, createDecryptStream(opts.encryptionKey!), gunzip, onError)
      : pipeline(src, gunzip, onError);
  const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;
  async function* lines(): AsyncGenerator<string> {
    const decoder = new StringDecoder('utf8');
    let buf = '';
    let total = 0;
    try {
      for await (const chunk of last as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > maxBytes) throw new BackupFormatError('バックアップの展開後のサイズが上限を超えています');
        buf += decoder.write(chunk);
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          yield line;
        }
        if (buf.length > MAX_LINE_BYTES) throw new BackupFormatError('バックアップの1行が長すぎます');
      }
    } catch (e) {
      if (e instanceof BackupFormatError) throw e;
      const msg = (e as Error).message ?? '';
      if (/incorrect header check|unexpected end of file|invalid|Z_BUF_ERROR|Z_DATA_ERROR/i.test(msg) || (e as { code?: string }).code?.startsWith('Z_')) {
        throw new BackupFormatError('バックアップファイルが破損しています(展開できません)');
      }
      throw e;
    } finally {
      src.destroy();
    }
    buf += decoder.end();
    if (buf.length > 0) yield buf;
  }
  return { encrypted: kind === 'encrypted', lines: lines() };
}
