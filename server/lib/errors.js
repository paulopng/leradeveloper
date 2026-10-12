// Typed error model — same JSON shape as the original Rust `AppError`
// (`{ code, ...fields }`), so the Svelte UI's `isAppError()` narrowing and
// toasts keep working unchanged.

export class AppError extends Error {
  constructor(code, fields = {}) {
    super(fields.message ?? code);
    this.payload = { code, ...fields };
  }
}

export const io = (message) => new AppError("io", { message });
export const invalidArgument = (message) => new AppError("invalid_argument", { message });
export const internal = (message) => new AppError("internal", { message });
export const network = (url, message) => new AppError("network", { url, message });
export const httpStatus = (url, status) => new AppError("http_status", { url, status });
export const paranoidBlocked = (feature) => new AppError("paranoid_mode_blocked", { feature });
export const authRequired = () => new AppError("auth_required");

/** Normalize any thrown value into an AppError payload for the wire. */
export function toPayload(err) {
  if (err instanceof AppError) return err.payload;
  return { code: "internal", message: err?.message ?? String(err) };
}
