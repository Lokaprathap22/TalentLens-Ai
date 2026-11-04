export class InvalidDocumentFormatError extends Error {
  constructor(message = 'Invalid or corrupt document format') {
    super(message);
    this.name = 'InvalidDocumentFormatError';
  }
}

export class SecurityLimitExceededError extends Error {
  constructor(message = 'Document exceeds security processing limits') {
    super(message);
    this.name = 'SecurityLimitExceededError';
  }
}

export class EncryptedDocumentError extends Error {
  constructor(message = 'Document is password-protected or encrypted') {
    super(message);
    this.name = 'EncryptedDocumentError';
  }
}
