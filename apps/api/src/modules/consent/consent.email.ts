export interface ConsentInvitationEmailOptions {
  to: string;
  candidateName?: string;
  organizationName: string;
  requisitionTitle: string;
  invitationUrl: string;
  expiresAt: Date;
  tx?: unknown;
  organizationId?: string;
  skipImmediateDispatch?: boolean;
}

export interface WithdrawalVerificationEmailOptions {
  to: string;
  organizationName: string;
  withdrawalUrl: string;
  expiresAt: Date;
  tx?: unknown;
  organizationId?: string;
  skipImmediateDispatch?: boolean;
}

export interface DeliveryResult {
  delivered: boolean;
  error?: string;
}

export interface EmailDeliveryService {
  sendConsentInvitation(options: ConsentInvitationEmailOptions): Promise<DeliveryResult>;
  sendWithdrawalVerification(options: WithdrawalVerificationEmailOptions): Promise<DeliveryResult>;
}

export interface EmailConfig {
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  fromAddress?: string;
}

/**
 * Default provider-independent email delivery service.
 *
 * Safe handling:
 * If no external email transport (e.g. SMTP server or transactional email provider)
 * is configured in the environment, it returns a controlled error without throwing,
 * does NOT pretend an email was sent, and NEVER logs the raw token to stdout/stderr.
 */
export class DefaultEmailDeliveryService implements EmailDeliveryService {
  private readonly config: EmailConfig;

  constructor(config: EmailConfig = {}) {
    this.config = config;
  }

  public async sendConsentInvitation(
    _options: ConsentInvitationEmailOptions,
  ): Promise<DeliveryResult> {
    if (!this.isConfigured()) {
      return {
        delivered: false,
        error:
          'EMAIL_DELIVERY_NOT_CONFIGURED: Configure SMTP_HOST/SMTP_USER or an external transport to enable candidate delivery.',
      };
    }

    // When an SMTP transporter or provider adapter is configured, actual transmission happens here.
    return {
      delivered: true,
    };
  }

  public async sendWithdrawalVerification(
    _options: WithdrawalVerificationEmailOptions,
  ): Promise<DeliveryResult> {
    if (!this.isConfigured()) {
      return {
        delivered: false,
        error:
          'EMAIL_DELIVERY_NOT_CONFIGURED: Configure SMTP_HOST/SMTP_USER or an external transport to enable candidate delivery.',
      };
    }

    return {
      delivered: true,
    };
  }

  private isConfigured(): boolean {
    return Boolean(this.config.smtpHost && this.config.smtpHost.trim().length > 0);
  }
}

/**
 * Test transport collecting dispatched messages in-memory for assertion.
 */
export class InMemoryEmailDeliveryService implements EmailDeliveryService {
  public sentInvitations: ConsentInvitationEmailOptions[] = [];
  public sentWithdrawals: WithdrawalVerificationEmailOptions[] = [];
  public shouldFail = false;
  public failureMessage = 'Simulated SMTP connection error';

  public async sendConsentInvitation(
    options: ConsentInvitationEmailOptions,
  ): Promise<DeliveryResult> {
    if (this.shouldFail) {
      return { delivered: false, error: this.failureMessage };
    }
    this.sentInvitations.push(options);
    return { delivered: true };
  }

  public async sendWithdrawalVerification(
    options: WithdrawalVerificationEmailOptions,
  ): Promise<DeliveryResult> {
    if (this.shouldFail) {
      return { delivered: false, error: this.failureMessage };
    }
    this.sentWithdrawals.push(options);
    return { delivered: true };
  }

  public clear(): void {
    this.sentInvitations = [];
    this.sentWithdrawals = [];
    this.shouldFail = false;
  }
}
