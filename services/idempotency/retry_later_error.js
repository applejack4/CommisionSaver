class RetryLaterError extends Error {
  constructor(message = 'Request is already being processed') {
    super(message);
    this.name = 'RetryLaterError';
    this.statusCode = 409;
  }
}

module.exports = {
  RetryLaterError
};
