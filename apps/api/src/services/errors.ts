export class ServiceError extends Error {
  constructor(
    public readonly message: string,
    public readonly code: string,
    public readonly status: 400 | 403 | 404 | 409 | 422
  ) {
    super(message)
    this.name = "ServiceError"
  }
}
