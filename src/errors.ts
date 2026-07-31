export class ValidationInputError extends Error {
  code: string;
  constructor(message: string, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'ValidationInputError';
    this.code = code;
  }
}

export class ProviderError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 502, code = 'PROVIDER_ERROR') {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
  }
}
