export class ControlPlaneError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, string | number>> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Readonly<Record<string, string | number>>,
  ) {
    super(message);
    this.name = "ControlPlaneError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function controlPlaneError(
  error: unknown,
  fallback = "Control-plane request failed",
): ControlPlaneError {
  if (error instanceof ControlPlaneError) return error;
  return new ControlPlaneError(500, "internal_error", fallback);
}
