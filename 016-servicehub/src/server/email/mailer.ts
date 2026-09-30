import nodemailer from 'nodemailer';
import type { AppConfig } from '../config.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  messageId: string;
  replyTo?: string | null;
}

export interface SendResult {
  providerMessageId: string | null;
}

export interface Mailer {
  readonly name: string;
  /** 実送信するか(false の場合は記録のみ) */
  readonly delivers: boolean;
  send(mail: OutgoingMail): Promise<SendResult>;
}

/** 送信しない(記録のみ)。既定。 */
export class LogMailer implements Mailer {
  readonly name = 'log';
  readonly delivers = false;
  readonly sent: OutgoingMail[] = [];
  constructor(private readonly echo = true) {}
  async send(mail: OutgoingMail): Promise<SendResult> {
    this.sent.push(mail);
    if (this.sent.length > 500) this.sent.shift();
    if (this.echo) {
      // 宛先はマスクして出力(個人情報をログに出しすぎない)
      console.info(`[mail:log] to=${mail.to.replace(/^(.{2}).*@/, '$1***@')} subject=${mail.subject}`);
    }
    return { providerMessageId: null };
  }
}

export class SmtpMailer implements Mailer {
  readonly name = 'smtp';
  readonly delivers = true;
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;
  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }
  async send(mail: OutgoingMail): Promise<SendResult> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      messageId: mail.messageId,
      replyTo: mail.replyTo ?? undefined,
    });
    return { providerMessageId: info.messageId ?? null };
  }
}

export function createMailer(config: AppConfig): Mailer {
  if (config.EMAIL_PROVIDER === 'smtp' && config.SMTP_URL) {
    return new SmtpMailer(config.SMTP_URL, config.EMAIL_FROM);
  }
  return new LogMailer(config.NODE_ENV !== 'test');
}
