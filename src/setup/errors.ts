/**
 * An expected setup failure with an explicitly safe browser explanation.
 * Keep paths, child output, and underlying diagnostics in message/cause only;
 * userMessage must be MEX-authored text and known relative setup paths.
 */
export class SetupError extends Error {
  readonly userMessage: string;

  constructor(message: string, options?: ErrorOptions & { userMessage?: string }) {
    super(message, options);
    this.name = "SetupError";
    this.userMessage = options?.userMessage ?? message;
  }
}

/** Classify known filesystem failures without inspecting or exposing their text.
 * operation must be authored text, never a path or message from the exception.
 */
export function classifySetupFileSystemError(error: unknown, operation: string): SetupError | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  let recovery: string;
  switch (error.code) {
    case "EACCES":
    case "EPERM":
      recovery = "Access was denied. Check the file and directory permissions, then retry setup.";
      break;
    case "EROFS":
      recovery = "The filesystem is read-only. Use a writable checkout, then retry setup.";
      break;
    case "ENOSPC":
    case "EDQUOT":
      recovery = "Storage is full or its quota was reached. Free disk space or increase the quota, then retry setup.";
      break;
    case "EBUSY":
      recovery = "A required file is busy. Close the process using it, then retry setup.";
      break;
    case "EEXIST":
    case "ENOTDIR":
    case "EISDIR":
    case "ELOOP":
      recovery = "A required path has a conflicting file, directory, or symbolic link. Correct it, then retry setup.";
      break;
    case "ENOENT":
      recovery = "A required file or directory is missing. Restore it, or reinstall MEX if its templates are missing, then retry setup.";
      break;
    case "EMFILE":
    case "ENFILE":
      recovery = "The system has too many open files. Close other processes, then retry setup.";
      break;
    default:
      return null;
  }
  return new SetupError(error.message, { cause: error, userMessage: `${operation} ${recovery}` });
}
