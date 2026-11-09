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

export class OcrRuntimeUnavailableError extends Error {
  constructor(
    message = 'OCR runtime (tesseract or pdftoppm) is not installed or available on this system',
  ) {
    super(message);
    this.name = 'OcrRuntimeUnavailableError';
  }
}

export class DocumentProcessingTimeoutError extends Error {
  constructor(message = 'Document processing exceeded timeout limit') {
    super(message);
    this.name = 'DocumentProcessingTimeoutError';
  }
}
