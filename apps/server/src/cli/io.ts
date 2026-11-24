import { AppError } from "../http/errors";

/** What a command reads and writes; tests pass their own. */
export type CliIo = {
  /** Everything on stdin, as text. */
  readStdin(): Promise<string>;
  /** The command's output: JSON or lines, never a secret. */
  out(text: string): void;
  /** Messages for the person at the terminal. */
  err(text: string): void;
};

/** A wrong command or option, or a body that is not JSON: exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
  constructor(
    message: string,
    /** The command's syntax, printed after the message. */
    readonly usage?: string,
  ) {
    super(message);
  }
}

/** The API's limit for JSON bodies. */
const MAX_BODY_BYTES = 512 * 1024;

export function processIo(): CliIo {
  return {
    async readStdin() {
      if (process.stdin.isTTY)
        process.stderr.write("Paste the JSON body, then press Ctrl-D on an empty line.\n");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES)
          throw new AppError(413, "payload_too_large", "The body is larger than 512 KiB");
        chunks.push(chunk);
      }
      // An editor may start the file with a byte order mark.
      return Buffer.concat(chunks)
        .toString("utf8")
        .replace(/^\uFEFF/, "");
    },
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
  };
}
