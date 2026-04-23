/**
 * Thrown by the deploy pipeline when the caller should see the underlying
 * reason — e.g. bad config, missing git remote, unsupported combination of
 * inputs. The HTTP route layer unwraps these and returns `message` to the
 * client with `status` (default 400).
 *
 * Plain `Error` is still the right choice for unexpected internal failures;
 * the route returns a generic "Deploy failed" + 500 for those so we don't
 * leak implementation detail from bugs, null derefs, etc.
 */
export class DeployError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "DeployError";
    this.status = status;
  }
}
