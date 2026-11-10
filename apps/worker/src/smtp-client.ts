import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

export interface SmtpAuthCredentials {
  user: string;
  pass: string;
}

export interface SmtpClientOptions {
  host: string;
  port: number;
  secure?: boolean | undefined; // true for port 465 SMTPS
  requireTls?: boolean | undefined; // true to enforce STARTTLS upgrade on plaintext ports
  rejectUnauthorized?: boolean | undefined; // default true; strict TLS certificate validation
  auth?: SmtpAuthCredentials | undefined;
  connectionTimeoutMs?: number | undefined; // default 10000ms
  socketTimeoutMs?: number | undefined; // default 15000ms
  clientHostname?: string | undefined; // default 'talentlens.ai'
  socketFactory?:
    | ((options: {
        host: string;
        port: number;
        secure?: boolean;
      }) => Promise<net.Socket | tls.TLSSocket>)
    | undefined;
}

export interface SmtpMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey?: string | undefined;
}

export interface SmtpSendResult {
  success: boolean;
  messageId?: string | undefined;
  response?: string | undefined;
  error?: string | undefined;
  isPermanentFailure: boolean;
}

interface SmtpServerReply {
  code: number;
  lines: string[];
  raw: string;
}

export class SmtpClient {
  private readonly host: string;
  private readonly port: number;
  private readonly secure: boolean;
  private readonly requireTls: boolean;
  private readonly rejectUnauthorized: boolean;
  private readonly auth?: SmtpAuthCredentials | undefined;
  private readonly connectionTimeoutMs: number;
  private readonly socketTimeoutMs: number;
  private readonly clientHostname: string;
  private readonly socketFactory?:
    | ((options: {
        host: string;
        port: number;
        secure?: boolean;
      }) => Promise<net.Socket | tls.TLSSocket>)
    | undefined;

  constructor(options: SmtpClientOptions) {
    if (!options.host || options.host.trim().length === 0) {
      throw new Error('SMTP host must be provided');
    }
    if (!options.port || options.port <= 0 || options.port > 65535) {
      throw new Error(`Invalid SMTP port: ${options.port}`);
    }

    this.host = options.host.trim();
    this.port = options.port;
    this.secure = options.secure ?? this.port === 465;
    this.requireTls = options.requireTls ?? this.port === 587;
    this.rejectUnauthorized = options.rejectUnauthorized ?? true;
    this.auth = options.auth;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 10000;
    this.socketTimeoutMs = options.socketTimeoutMs ?? 15000;
    this.clientHostname = options.clientHostname ?? 'talentlens.ai';
    this.socketFactory = options.socketFactory;
  }

  /**
   * Executes genuine SMTP delivery to the remote MTA.
   * Returns a structured SmtpSendResult with permanent vs transient classification.
   */
  public async send(message: SmtpMessage): Promise<SmtpSendResult> {
    if (!message.to || !message.to.includes('@')) {
      return {
        success: false,
        error: 'Invalid recipient email address',
        isPermanentFailure: true,
      };
    }

    let socket: net.Socket | tls.TLSSocket | null = null;
    let timer: NodeJS.Timeout | null = null;

    try {
      // 1. Establish initial transport socket
      socket = await this.connectSocket();

      // Buffer accumulator for SMTP line reads
      let readBuffer = '';
      let pendingResolve: ((reply: SmtpServerReply) => void) | null = null;
      let pendingReject: ((err: Error) => void) | null = null;

      const resetTimeout = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const timeoutErr = new Error(
            `SMTP socket inactivity timeout after ${this.socketTimeoutMs}ms`,
          );
          timeoutErr.name = 'SmtpTimeoutError';
          if (socket && !socket.destroyed) {
            socket.destroy(timeoutErr);
          }
          if (pendingReject) {
            pendingReject(timeoutErr);
            pendingResolve = null;
            pendingReject = null;
          }
        }, this.socketTimeoutMs);
      };

      const readReply = (): Promise<SmtpServerReply> => {
        resetTimeout();
        return new Promise((resolve, reject) => {
          const checkBuffer = () => {
            const lines = readBuffer.split('\r\n');
            if (lines.length > 1) {
              // We have at least one complete line
              for (let i = 0; i < lines.length - 1; i++) {
                const line = lines[i]!;
                const match = /^(\d{3})([ -])(.*)$/.exec(line);
                if (match) {
                  const code = parseInt(match[1]!, 10);
                  const isLastLine = match[2] === ' ';
                  if (isLastLine) {
                    const consumed = lines.slice(0, i + 1).join('\r\n') + '\r\n';
                    readBuffer = readBuffer.slice(consumed.length);
                    const collectedLines = lines.slice(0, i + 1);
                    return resolve({
                      code,
                      lines: collectedLines,
                      raw: line,
                    });
                  }
                }
              }
            }
          };

          // Check if buffer already has a full reply
          const lines = readBuffer.split('\r\n');
          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i]!;
            const match = /^(\d{3})([ -])(.*)$/.exec(line);
            if (match && match[2] === ' ') {
              checkBuffer();
              return;
            }
          }

          pendingResolve = resolve;
          pendingReject = reject;
        });
      };

      const onData = (chunk: Buffer) => {
        readBuffer += chunk.toString('utf8');
        if (pendingResolve) {
          const lines = readBuffer.split('\r\n');
          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i]!;
            const match = /^(\d{3})([ -])(.*)$/.exec(line);
            if (match && match[2] === ' ') {
              const code = parseInt(match[1]!, 10);
              const consumed = lines.slice(0, i + 1).join('\r\n') + '\r\n';
              readBuffer = readBuffer.slice(consumed.length);
              const resolve = pendingResolve;
              pendingResolve = null;
              pendingReject = null;
              resolve({
                code,
                lines: lines.slice(0, i + 1),
                raw: line,
              });
              return;
            }
          }
        }
      };

      socket.on('data', onData);

      const onError = (err: Error) => {
        if (pendingReject) {
          const reject = pendingReject;
          pendingResolve = null;
          pendingReject = null;
          reject(err);
        }
      };
      socket.on('error', onError);

      // 2. Read greeting banner (220)
      const greeting = await readReply();
      if (greeting.code !== 220) {
        throw this.createSmtpError(greeting.code, `Server rejected connection: ${greeting.raw}`);
      }

      // 3. Send EHLO
      await this.sendCommand(socket, `EHLO ${this.clientHostname}`);
      let ehloReply = await readReply();
      if (ehloReply.code !== 250) {
        // Fall back to HELO if EHLO not supported
        await this.sendCommand(socket, `HELO ${this.clientHostname}`);
        ehloReply = await readReply();
        if (ehloReply.code !== 250) {
          throw this.createSmtpError(ehloReply.code, `EHLO/HELO failed: ${ehloReply.raw}`);
        }
      }

      // 4. Handle STARTTLS if not already secure
      const serverCapabilities = ehloReply.lines.map((l) => l.toUpperCase());
      const supportsStartTls = serverCapabilities.some((l) => l.includes('STARTTLS'));

      if (!this.secure) {
        if (supportsStartTls) {
          await this.sendCommand(socket, 'STARTTLS');
          const startTlsReply = await readReply();
          if (startTlsReply.code !== 220) {
            throw this.createSmtpError(startTlsReply.code, `STARTTLS failed: ${startTlsReply.raw}`);
          }

          // Socket upgrade to TLS
          socket.removeListener('data', onData);
          socket.removeListener('error', onError);

          socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
            const tlsSocket = tls.connect({
              socket: socket as net.Socket,
              host: this.host,
              ...(net.isIP(this.host) === 0 ? { servername: this.host } : {}),
              rejectUnauthorized: this.rejectUnauthorized,
            });
            tlsSocket.once('secureConnect', () => resolve(tlsSocket));
            tlsSocket.once('error', reject);
          });

          socket.on('data', onData);
          socket.on('error', onError);

          // After STARTTLS, RFC 3207 requires re-issuing EHLO
          await this.sendCommand(socket, `EHLO ${this.clientHostname}`);
          ehloReply = await readReply();
          if (ehloReply.code !== 250) {
            throw this.createSmtpError(ehloReply.code, `Post-TLS EHLO failed: ${ehloReply.raw}`);
          }
        } else if (this.requireTls) {
          throw new Error(
            'STARTTLS is required by configuration but not supported by remote SMTP server',
          );
        }
      }

      // 5. Authenticate if credentials provided
      if (this.auth && this.auth.user && this.auth.pass) {
        const upgradedCapabilities = ehloReply.lines.map((l) => l.toUpperCase());
        const hasAuthPlain = upgradedCapabilities.some(
          (l) => l.includes('AUTH') && l.includes('PLAIN'),
        );
        const hasAuthLogin = upgradedCapabilities.some(
          (l) => l.includes('AUTH') && l.includes('LOGIN'),
        );

        if (hasAuthPlain) {
          const authString = `\0${this.auth.user}\0${this.auth.pass}`;
          const encoded = Buffer.from(authString, 'utf8').toString('base64');
          await this.sendCommand(socket, `AUTH PLAIN ${encoded}`);
          const authReply = await readReply();
          if (authReply.code !== 235) {
            throw this.createSmtpError(
              authReply.code,
              `SMTP AUTH PLAIN rejected: ${authReply.raw}`,
            );
          }
        } else if (hasAuthLogin) {
          await this.sendCommand(socket, 'AUTH LOGIN');
          const prompt1 = await readReply();
          if (prompt1.code !== 334) {
            throw this.createSmtpError(
              prompt1.code,
              `SMTP AUTH LOGIN prompt 1 rejected: ${prompt1.raw}`,
            );
          }
          await this.sendCommand(socket, Buffer.from(this.auth.user, 'utf8').toString('base64'));
          const prompt2 = await readReply();
          if (prompt2.code !== 334) {
            throw this.createSmtpError(
              prompt2.code,
              `SMTP AUTH LOGIN prompt 2 rejected: ${prompt2.raw}`,
            );
          }
          await this.sendCommand(socket, Buffer.from(this.auth.pass, 'utf8').toString('base64'));
          const authReply = await readReply();
          if (authReply.code !== 235) {
            throw this.createSmtpError(
              authReply.code,
              `SMTP AUTH LOGIN password rejected: ${authReply.raw}`,
            );
          }
        } else {
          // If server offers AUTH without specific listed mechanisms, attempt AUTH PLAIN
          const authString = `\0${this.auth.user}\0${this.auth.pass}`;
          const encoded = Buffer.from(authString, 'utf8').toString('base64');
          await this.sendCommand(socket, `AUTH PLAIN ${encoded}`);
          const authReply = await readReply();
          if (authReply.code !== 235) {
            throw this.createSmtpError(authReply.code, `SMTP AUTH rejected: ${authReply.raw}`);
          }
        }
      }

      // 6. MAIL FROM
      const envelopeFrom = this.sanitizeEnvelopeAddress(message.from);
      await this.sendCommand(socket, `MAIL FROM:<${envelopeFrom}>`);
      const mailFromReply = await readReply();
      if (mailFromReply.code !== 250) {
        throw this.createSmtpError(mailFromReply.code, `MAIL FROM rejected: ${mailFromReply.raw}`);
      }

      // 7. RCPT TO
      const envelopeTo = this.sanitizeEnvelopeAddress(message.to);
      await this.sendCommand(socket, `RCPT TO:<${envelopeTo}>`);
      const rcptToReply = await readReply();
      if (rcptToReply.code !== 250 && rcptToReply.code !== 251) {
        throw this.createSmtpError(rcptToReply.code, `RCPT TO rejected: ${rcptToReply.raw}`);
      }

      // 8. DATA
      await this.sendCommand(socket, 'DATA');
      const dataReply = await readReply();
      if (dataReply.code !== 354) {
        throw this.createSmtpError(dataReply.code, `DATA command rejected: ${dataReply.raw}`);
      }

      // 9. Send RFC 5322 MIME Content
      const mimePayload = this.buildMimeMessage(message);
      await this.sendData(socket, mimePayload);
      const deliveryReply = await readReply();
      if (deliveryReply.code !== 250) {
        throw this.createSmtpError(
          deliveryReply.code,
          `Message delivery rejected: ${deliveryReply.raw}`,
        );
      }

      // 10. QUIT
      try {
        await this.sendCommand(socket, 'QUIT');
        await readReply();
      } catch {
        // Ignore quit reply failure after successful message delivery
      }

      // Extract message ID from server 250 response or generated mime header
      const extractedId =
        this.extractMessageId(deliveryReply.raw) ?? `<${randomUUID()}@${this.host}>`;

      return {
        success: true,
        messageId: extractedId,
        response: deliveryReply.raw,
        isPermanentFailure: false,
      };
    } catch (err: unknown) {
      const error = err as Error & { code?: number; isPermanentFailure?: boolean };
      const errorMessage = error.message || 'SMTP delivery failure';
      const isPermanent = error.isPermanentFailure ?? this.isPermanentError(error);

      return {
        success: false,
        error: errorMessage,
        isPermanentFailure: isPermanent,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (socket && !socket.destroyed) {
        socket.destroy();
      }
    }
  }

  private connectSocket(): Promise<net.Socket | tls.TLSSocket> {
    if (this.socketFactory) {
      return this.socketFactory({ host: this.host, port: this.port, secure: this.secure });
    }

    return new Promise((resolve, reject) => {
      let timeoutTimer: NodeJS.Timeout | null = null;

      const onTimeout = () => {
        if (sock && !sock.destroyed) {
          sock.destroy();
        }
        const err = new Error(
          `Connection timeout after ${this.connectionTimeoutMs}ms to ${this.host}:${this.port}`,
        );
        err.name = 'SmtpConnectionTimeoutError';
        reject(err);
      };

      timeoutTimer = setTimeout(onTimeout, this.connectionTimeoutMs);

      let sock: net.Socket | tls.TLSSocket;

      if (this.secure) {
        sock = tls.connect({
          host: this.host,
          port: this.port,
          ...(net.isIP(this.host) === 0 ? { servername: this.host } : {}),
          rejectUnauthorized: this.rejectUnauthorized,
        });
        (sock as tls.TLSSocket).once('secureConnect', () => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          resolve(sock);
        });
      } else {
        sock = net.createConnection({
          host: this.host,
          port: this.port,
        });
        sock.once('connect', () => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          resolve(sock);
        });
      }

      sock.once('error', (err) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        reject(err);
      });
    });
  }

  private sendCommand(socket: net.Socket | tls.TLSSocket, cmd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.write(`${cmd}\r\n`, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Strips CR and LF characters from an SMTP header value to prevent header injection.
   * RFC 5321 §4.1.1: Header field values must not contain bare CR or LF.
   */
  public sanitizeHeaderValue(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').trim();
  }

  /**
   * Extracts and strictly validates an email address for SMTP envelope commands (MAIL FROM, RCPT TO).
   * Strips display names if formatted as `Name <addr@domain>`, but strictly rejects any invalid values,
   * newlines, carriage returns, or control characters rather than transforming them.
   * Prevents SMTP command injection into the protocol envelope.
   */
  public sanitizeEnvelopeAddress(address: string): string {
    if (!address || typeof address !== 'string') {
      throw new Error('Invalid envelope email address: address must be a non-empty string');
    }

    // Strictly reject CRLF, null bytes, or ASCII control characters anywhere in the input
    for (let i = 0; i < address.length; i++) {
      const code = address.charCodeAt(i);
      if (code <= 31 || code === 127) {
        throw new Error(
          `Invalid envelope email address: illegal characters detected in "${address}"`,
        );
      }
    }

    // Extract address from <address> if formatted with a display name
    const angleMatch = /<([^>]+)>/.exec(address);
    const candidate = (angleMatch ? angleMatch[1] : address)!.trim();

    // RFC 5321 addr-spec validation
    const emailRegex =
      /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    if (!emailRegex.test(candidate)) {
      throw new Error(
        `Invalid envelope email address: "${address}" does not match RFC 5321 syntax`,
      );
    }

    return candidate.toLowerCase();
  }

  /**
   * Sanitizes header values and applies RFC 2047 Base64 encoded-word format
   * if the text contains non-ASCII characters, preventing header corruption
   * or line breaks across strict 7-bit ASCII SMTP relays.
   */
  public encodeHeaderValue(value: string): string {
    const sanitized = this.sanitizeHeaderValue(value);
    if (/^[\x20-\x7E]*$/.test(sanitized)) {
      return sanitized;
    }
    const encoded = Buffer.from(sanitized, 'utf8').toString('base64');
    return `=?utf-8?B?${encoded}?=`;
  }

  /**
   * Formats an RFC 5322 From or To header, preserving display names while encoding non-ASCII
   * characters in the display name and stripping CRLF.
   */
  public formatHeaderAddress(value: string): string {
    const sanitized = this.sanitizeHeaderValue(value);
    const match = /^(.*)<([^>]+)>$/.exec(sanitized);
    if (match) {
      const displayName = match[1]!.trim();
      const address = match[2]!.replace(/[\r\n\s<>]+/g, '').trim();
      const encodedName = this.encodeHeaderValue(displayName);
      return `${encodedName} <${address}>`;
    }
    return this.sanitizeHeaderValue(value);
  }

  private sendData(socket: net.Socket | tls.TLSSocket, data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Dot-stuffing according to RFC 5321 §4.5.2:
      // Any line starting with '.' must be prepended with an extra '.'.
      // This handles internal lines (\r\n.) but we also handle the case where
      // the DATA itself begins with '.' (the first character of the message body).
      let stuffed = data.replace(/\r?\n\./g, '\r\n..');
      if (stuffed.startsWith('.')) {
        stuffed = '.' + stuffed;
      }
      const payload = stuffed.endsWith('\r\n') ? `${stuffed}.\r\n` : `${stuffed}\r\n.\r\n`;
      socket.write(payload, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private buildMimeMessage(message: SmtpMessage): string {
    const boundary = `----=_Part_${randomUUID()}`;
    const dateHeader = new Date().toUTCString();
    const messageId = `<${Date.now()}.${randomUUID().slice(0, 8)}@${this.host}>`;

    const headers = [
      `From: ${this.formatHeaderAddress(message.from)}`,
      `To: ${this.formatHeaderAddress(message.to)}`,
      `Subject: ${this.encodeHeaderValue(message.subject)}`,
      `Date: ${dateHeader}`,
      `Message-ID: ${messageId}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ];

    if (message.idempotencyKey) {
      headers.push(
        `X-TalentLens-Idempotency: ${this.sanitizeHeaderValue(message.idempotencyKey).slice(0, 32)}`,
      );
    }

    const body = [
      headers.join('\r\n'),
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      message.text,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      message.html,
      '',
      `--${boundary}--`,
    ].join('\r\n');

    return body;
  }

  private extractMessageId(responseLine: string): string | null {
    // E.g.: "250 2.0.0 Ok: queued as 4QvFhC3... or id=123"
    const match = /(?:queued as|id=|message-id:?)\s*([^\s<]+)/i.exec(responseLine);
    if (match && match[1]) {
      return match[1].replace(/[<>,.]/g, '');
    }
    return null;
  }

  private createSmtpError(
    code: number,
    message: string,
  ): Error & { code: number; isPermanentFailure: boolean } {
    const err = new Error(`SMTP error (${code}): ${message}`) as Error & {
      code: number;
      isPermanentFailure: boolean;
    };
    err.code = code;
    // 5xx codes are permanent; 4xx codes are transient
    err.isPermanentFailure = code >= 500 && code < 600;
    return err;
  }

  private isPermanentError(error: Error & { code?: number }): boolean {
    if (error.code && error.code >= 500 && error.code < 600) {
      return true;
    }
    const msg = error.message.toLowerCase();
    return (
      msg.includes('user unknown') ||
      msg.includes('invalid recipient') ||
      msg.includes('mailbox unavailable') ||
      msg.includes('relay access denied') ||
      msg.includes('authentication failed') ||
      msg.includes('535') ||
      msg.includes('550') ||
      msg.includes('551') ||
      msg.includes('553') ||
      msg.includes('554') ||
      msg.includes('cert_has_expired') ||
      msg.includes('unable_to_verify_leaf_signature')
    );
  }
}
