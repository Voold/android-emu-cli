export class SdkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SdkError';
  }
}
