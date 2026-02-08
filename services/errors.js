class RetryableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RetryableError';
    this.code = details.code || 'RETRYABLE_ERROR';
    this.details = details;
  }
}

class NonRetryableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'NonRetryableError';
    this.code = details.code || 'NON_RETRYABLE_ERROR';
    this.details = details;
  }
}

module.exports = {
  RetryableError,
  NonRetryableError
};
