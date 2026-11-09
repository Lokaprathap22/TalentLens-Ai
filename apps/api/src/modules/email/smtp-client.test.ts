import { Duplex } from 'node:stream';
import type net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmtpClient } from './smtp-client.js';

interface MockSmtpBehavior {
  rejectGreeting?: boolean;
  rejectAuth?: boolean;
  rejectRcpt?: { code: number; message: string };
  rejectData?: { code: number; message: string };
  hangOnCommand?: string;
  customMessageId?: string;
}

class InProcessSocket extends Duplex {
  public peer?: InProcessSocket;
  public override destroyed = false;
  private timeoutTimer: NodeJS.Timeout | null = null;

  override _read() {}

  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (error?: Error | null) => void,
  ) {
    if (this.peer && !this.peer.destroyed) {
      this.peer.push(Buffer.from(chunk));
    }
    cb();
  }

  setTimeout(ms: number, cb?: () => void) {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (ms > 0 && cb) {
      this.timeoutTimer = setTimeout(cb, ms);
    }
    return this;
  }

  override destroy(err?: Error) {
    this.destroyed = true;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    super.destroy(err);
    if (err) {
      this.emit('error', err);
    }
    this.emit('close');
    return this;
  }
}

class LocalTestSmtpServer {
  public receivedMessages: Array<{ mailFrom: string; rcptTo: string; data: string }> = [];
  public authAttempts: Array<string> = [];
  public behavior: MockSmtpBehavior = {};

  public createSession(): InProcessSocket {
    const clientSocket = new InProcessSocket();
    const serverSocket = new InProcessSocket();
    clientSocket.peer = serverSocket;
    serverSocket.peer = clientSocket;

    this.handleSocket(serverSocket);
    return clientSocket;
  }

  private handleSocket(socket: InProcessSocket) {
    let readingData = false;
    let dataBuffer = '';
    let currentMailFrom = '';
    let currentRcptTo = '';

    if (this.behavior.rejectGreeting) {
      socket.write('554 5.7.1 Service unavailable\r\n');
      socket.destroy();
      return;
    }

    socket.write('220 localhost ESMTP TestServer Ready\r\n');

    socket.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf8');

      if (readingData) {
        dataBuffer += str;
        if (dataBuffer.includes('\r\n.\r\n')) {
          readingData = false;
          if (this.behavior.rejectData) {
            socket.write(
              `${this.behavior.rejectData.code} ${this.behavior.rejectData.message}\r\n`,
            );
          } else {
            this.receivedMessages.push({
              mailFrom: currentMailFrom,
              rcptTo: currentRcptTo,
              data: dataBuffer,
            });
            const qid = this.behavior.customMessageId ?? 'test-queue-id-9988';
            socket.write(`250 2.0.0 Ok: queued as ${qid}\r\n`);
          }
        }
        return;
      }

      const lines = str.split('\r\n').filter(Boolean);
      for (const line of lines) {
        const upper = line.trim().toUpperCase();

        if (this.behavior.hangOnCommand && upper.startsWith(this.behavior.hangOnCommand)) {
          return;
        }

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write(
            '250-localhost Hello client\r\n250-SIZE 10485760\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n',
          );
        } else if (upper.startsWith('AUTH PLAIN')) {
          this.authAttempts.push(line);
          if (this.behavior.rejectAuth) {
            socket.write('535 5.7.8 Authentication credentials invalid\r\n');
          } else {
            socket.write('235 2.7.0 Authentication successful\r\n');
          }
        } else if (upper.startsWith('MAIL FROM:')) {
          const match = /<([^>]*)>/.exec(line);
          currentMailFrom = match ? match[1]! : line.slice(10).trim();
          socket.write('250 2.1.0 Sender OK\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          if (this.behavior.rejectRcpt) {
            socket.write(
              `${this.behavior.rejectRcpt.code} ${this.behavior.rejectRcpt.message}\r\n`,
            );
          } else {
            const match = /<([^>]*)>/.exec(line);
            currentRcptTo = match ? match[1]! : line.slice(8).trim();
            socket.write('250 2.1.5 Recipient OK\r\n');
          }
        } else if (upper === 'DATA') {
          readingData = true;
          dataBuffer = '';
          socket.write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.destroy();
        } else if (upper === 'RSET') {
          socket.write('250 2.0.0 OK\r\n');
        } else {
          socket.write('500 5.5.1 Command unrecognized\r\n');
        }
      }
    });
  }
}

describe('SmtpClient (API) — Genuine SMTP Delivery and Network State Unit Tests', () => {
  let server: LocalTestSmtpServer;

  beforeEach(() => {
    server = new LocalTestSmtpServer();
  });

  afterEach(() => {
    server.receivedMessages = [];
  });

  it('delivers email successfully against a real local SMTP test server and records server queue ID', async () => {
    server.behavior.customMessageId = 'test-mta-ack-7711';
    const client = new SmtpClient({
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      requireTls: false,
      auth: { user: 'recruiter@talentlens.ai', pass: 'secretpass' },
      socketFactory: async () => server.createSession() as unknown as net.Socket,
    });

    const result = await client.send({
      from: 'no-reply@talentlens.ai',
      to: 'candidate@example.com',
      subject: 'Interview Consent',
      html: '<h1>Consent Request</h1>',
      text: 'Consent Request',
      idempotencyKey: 'idemp-12345',
    });

    expect(result.success).toBe(true);
    expect(result.isPermanentFailure).toBe(false);
    expect(result.messageId).toBe('test-mta-ack-7711');
    expect(server.receivedMessages).toHaveLength(1);
    expect(server.receivedMessages[0]?.mailFrom).toBe('no-reply@talentlens.ai');
    expect(server.receivedMessages[0]?.rcptTo).toBe('candidate@example.com');
    expect(server.receivedMessages[0]?.data).toContain('Subject: Interview Consent');
    expect(server.receivedMessages[0]?.data).toContain('X-TalentLens-Idempotency: idemp-12345');
  });

  it('handles authentication failure (535) as a permanent failure', async () => {
    server.behavior.rejectAuth = true;
    const client = new SmtpClient({
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      requireTls: false,
      auth: { user: 'recruiter@talentlens.ai', pass: 'wrongpass' },
      socketFactory: async () => server.createSession() as unknown as net.Socket,
    });

    const result = await client.send({
      from: 'no-reply@talentlens.ai',
      to: 'candidate@example.com',
      subject: 'Test Subject',
      html: '<p>Test</p>',
      text: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.isPermanentFailure).toBe(true);
    expect(result.error).toContain('535');
    expect(server.receivedMessages).toHaveLength(0);
  });

  it('handles transient SMTP rejection (451) with isPermanentFailure = false', async () => {
    server.behavior.rejectRcpt = { code: 451, message: '4.3.0 Mailbox temporarily unavailable' };
    const client = new SmtpClient({
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      requireTls: false,
      socketFactory: async () => server.createSession() as unknown as net.Socket,
    });

    const result = await client.send({
      from: 'no-reply@talentlens.ai',
      to: 'transient@example.com',
      subject: 'Transient Test',
      html: '<p>Test</p>',
      text: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.isPermanentFailure).toBe(false);
    expect(result.error).toContain('451');
    expect(server.receivedMessages).toHaveLength(0);
  });

  it('handles permanent SMTP rejection (550) with isPermanentFailure = true', async () => {
    server.behavior.rejectRcpt = { code: 550, message: '5.1.1 User unknown' };
    const client = new SmtpClient({
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      requireTls: false,
      socketFactory: async () => server.createSession() as unknown as net.Socket,
    });

    const result = await client.send({
      from: 'no-reply@talentlens.ai',
      to: 'unknown-candidate@example.com',
      subject: 'Permanent Reject Test',
      html: '<p>Test</p>',
      text: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.isPermanentFailure).toBe(true);
    expect(result.error).toContain('550');
    expect(server.receivedMessages).toHaveLength(0);
  });

  it('handles socket inactivity timeout correctly with isPermanentFailure = false', async () => {
    server.behavior.hangOnCommand = 'DATA';
    const client = new SmtpClient({
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      requireTls: false,
      socketTimeoutMs: 150,
      socketFactory: async () => server.createSession() as unknown as net.Socket,
    });

    const result = await client.send({
      from: 'no-reply@talentlens.ai',
      to: 'timeout@example.com',
      subject: 'Timeout Test',
      html: '<p>Test</p>',
      text: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.isPermanentFailure).toBe(false);
    expect(result.error).toContain('timeout');
    expect(server.receivedMessages).toHaveLength(0);
  });

  it('handles connection refused error gracefully without crashing', async () => {
    const client = new SmtpClient({
      host: '127.0.0.1',
      port: 19999,
      secure: false,
      requireTls: false,
      socketFactory: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:19999');
      },
    });

    const result = await client.send({
      from: 'no-reply@talentlens.ai',
      to: 'conn-refused@example.com',
      subject: 'Connection Test',
      html: '<p>Test</p>',
      text: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.isPermanentFailure).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('rejects invalid recipient format before opening connection', async () => {
    const client = new SmtpClient({
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      requireTls: false,
      socketFactory: async () => server.createSession() as unknown as net.Socket,
    });

    const result = await client.send({
      from: 'no-reply@talentlens.ai',
      to: 'not-an-email',
      subject: 'Invalid email',
      html: '<p>Test</p>',
      text: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.isPermanentFailure).toBe(true);
    expect(result.error).toContain('Invalid recipient');
  });

  it('strictly rejects envelope addresses containing CRLF, null bytes, or invalid syntax', async () => {
    const client = new SmtpClient({
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      requireTls: false,
      socketFactory: async () => server.createSession() as unknown as net.Socket,
    });

    const crlfResult = await client.send({
      from: 'no-reply@talentlens.ai\r\nRCPT TO:<attacker@evil.com>',
      to: 'candidate@example.com',
      subject: 'Valid Subject',
      html: '<p>Body</p>',
      text: 'Body',
    });

    expect(crlfResult.success).toBe(false);
    expect(crlfResult.error).toContain('illegal characters detected');
    expect(server.receivedMessages).toHaveLength(0);

    const malformedResult = await client.send({
      from: 'no-reply@talentlens.ai',
      to: 'candidate@@@example..com',
      subject: 'Valid Subject',
      html: '<p>Body</p>',
      text: 'Body',
    });

    expect(malformedResult.success).toBe(false);
    expect(malformedResult.error).toContain('does not match RFC 5321 syntax');
    expect(server.receivedMessages).toHaveLength(0);
  });

  it('prevents CRLF header injection and sanitizes Subject and Idempotency headers', async () => {
    const client = new SmtpClient({
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      requireTls: false,
      socketFactory: async () => server.createSession() as unknown as net.Socket,
    });

    const maliciousSubject = 'Interview Update\r\nBcc: spy@attacker.com\r\nX-Injected: true';

    const result = await client.send({
      from: 'no-reply@talentlens.ai',
      to: 'candidate@example.com',
      subject: maliciousSubject,
      html: '<p>Body</p>',
      text: 'Body',
      idempotencyKey: 'key\r\nInjectedHeader: evil',
    });

    expect(result.success).toBe(true);
    const sent = server.receivedMessages[0]?.data ?? '';

    expect(sent).not.toMatch(/\r\nBcc:/i);
    expect(sent).not.toMatch(/\r\nX-Injected:/i);
    expect(sent).not.toMatch(/\r\nInjectedHeader:/i);
    expect(server.receivedMessages[0]?.mailFrom).toBe('no-reply@talentlens.ai');
    expect(server.receivedMessages[0]?.rcptTo).toBe('candidate@example.com');
  });

  it('correctly handles display names in From and To without breaking SMTP envelope syntax', async () => {
    const client = new SmtpClient({
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      requireTls: false,
      socketFactory: async () => server.createSession() as unknown as net.Socket,
    });

    const result = await client.send({
      from: '"TalentLens Recruiting Team" <recruiting@talentlens.ai>',
      to: '"Jane Candidate" <jane.candidate@example.com>',
      subject: 'Your Application Status',
      html: '<p>Welcome</p>',
      text: 'Welcome',
    });

    expect(result.success).toBe(true);
    expect(server.receivedMessages[0]?.mailFrom).toBe('recruiting@talentlens.ai');
    expect(server.receivedMessages[0]?.rcptTo).toBe('jane.candidate@example.com');

    const sent = server.receivedMessages[0]?.data ?? '';
    expect(sent).toContain('From: "TalentLens Recruiting Team" <recruiting@talentlens.ai>');
    expect(sent).toContain('To: "Jane Candidate" <jane.candidate@example.com>');
  });

  it('performs dot-stuffing when a message begins with a period and at internal line boundaries', async () => {
    const client = new SmtpClient({
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      requireTls: false,
      socketFactory: async () => server.createSession() as unknown as net.Socket,
    });

    const textWithDots =
      '.First line begins with dot\n.Second line begins with dot\r\n.Third line\r\nNormal line';

    const result = await client.send({
      from: 'no-reply@talentlens.ai',
      to: 'candidate@example.com',
      subject: 'Dot-Stuffing Test',
      html: '<p>.Paragraph dot</p>',
      text: textWithDots,
    });

    expect(result.success).toBe(true);
    const sent = server.receivedMessages[0]?.data ?? '';

    expect(sent).toContain('\r\n..First line begins with dot');
    expect(sent).toContain('\r\n..Second line begins with dot');
    expect(sent).toContain('\r\n..Third line');
    expect(sent.endsWith('\r\n.\r\n')).toBe(true);
  });

  it('encodes non-ASCII Unicode characters in Subject using RFC 2047 Base64', async () => {
    const client = new SmtpClient({
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      requireTls: false,
      socketFactory: async () => server.createSession() as unknown as net.Socket,
    });

    const unicodeSubject = 'TalentLens AI — Interview with René & François 🚀';

    const result = await client.send({
      from: 'no-reply@talentlens.ai',
      to: 'candidate@example.com',
      subject: unicodeSubject,
      html: '<p>Unicode Test</p>',
      text: 'Unicode Test',
    });

    expect(result.success).toBe(true);
    const sent = server.receivedMessages[0]?.data ?? '';

    expect(sent).toMatch(/Subject:\s*=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=/);

    const match = /Subject:\s*=\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=/.exec(sent);
    expect(match).not.toBeNull();
    const decoded = Buffer.from(match![1]!, 'base64').toString('utf8');
    expect(decoded).toBe(unicodeSubject);
  });
});
