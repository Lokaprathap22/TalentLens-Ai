import type { EmailProvider, ProviderSendResult } from './email.types.js';
import { SmtpClient } from './smtp-client.js';

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string | undefined;
  pass?: string | undefined;
  fromAddress: string;
  secure?: boolean | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Null provider used when no transactional email provider or SMTP host is configured.
 * Does not pretend an email was sent. Returns a controlled EMAIL_DELIVERY_NOT_CONFIGURED status.
 */
export class NullEmailProvider implements EmailProvider {
  public async send(): Promise<ProviderSendResult> {
    return {
      success: false,
      error: 'EMAIL_DELIVERY_NOT_CONFIGURED',
      isPermanentFailure: false,
    };
  }
}

/**
 * In-memory test provider capturing sent messages with simulated network conditions.
 */
export class InMemoryEmailProvider implements EmailProvider {
  public sentMessages: Array<{
    to: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey?: string | undefined;
    sentAt: Date;
  }> = [];

  public shouldFail = false;
  public shouldTimeout = false;
  public isPermanentFailure = false;
  public failureErrorMessage = 'Simulated SMTP connection error';
  public timeoutMs = 50;

  public async send(message: {
    to: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey?: string | undefined;
  }): Promise<ProviderSendResult> {
    if (this.shouldTimeout) {
      await new Promise((resolve) => setTimeout(resolve, this.timeoutMs));
      return {
        success: false,
        error: 'PROVIDER_TIMEOUT: Email transport connection timed out',
        isPermanentFailure: false,
      };
    }

    if (this.shouldFail) {
      return {
        success: false,
        error: this.failureErrorMessage,
        isPermanentFailure: this.isPermanentFailure,
      };
    }

    this.sentMessages.push({
      ...message,
      sentAt: new Date(),
    });

    return {
      success: true,
      messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  public clear(): void {
    this.sentMessages = [];
    this.shouldFail = false;
    this.shouldTimeout = false;
    this.isPermanentFailure = false;
  }
}

/**
 * Configurable SMTP provider for production email delivery.
 * Encapsulates genuine socket transmission with timeouts and error handling.
 */
export class SmtpEmailProvider implements EmailProvider {
  private readonly client: SmtpClient | null = null;
  private readonly fromAddress: string;

  constructor(config: SmtpConfig, customClient?: SmtpClient) {
    this.fromAddress = config.fromAddress;
    if (customClient) {
      this.client = customClient;
    } else if (config.host && config.host.trim().length > 0) {
      this.client = new SmtpClient({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
        connectionTimeoutMs: config.timeoutMs,
        socketTimeoutMs: config.timeoutMs,
      });
    }
  }

  public async send(message: {
    to: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey?: string | undefined;
  }): Promise<ProviderSendResult> {
    if (!this.client) {
      return {
        success: false,
        error: 'EMAIL_DELIVERY_NOT_CONFIGURED: Missing SMTP host',
        isPermanentFailure: true,
      };
    }

    const result = await this.client.send({
      from: this.fromAddress,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      idempotencyKey: message.idempotencyKey,
    });

    return {
      success: result.success,
      messageId: result.messageId,
      error: result.error,
      isPermanentFailure: result.isPermanentFailure,
    };
  }
}
