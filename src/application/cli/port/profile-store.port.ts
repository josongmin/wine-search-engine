import type { GlobalArgs } from '../context/global-args.js';
import type { ResolvedCliProfile } from '../context/cli-profile.js';

export interface ResolveProfileInput {
  readonly args: GlobalArgs;
}

/**
 * Resolves a {@link ResolvedCliProfile} under the precedence
 * `flags > env > profile store > defaults`. Commands never recompute this —
 * they read the resolved profile from the command context.
 */
export interface ProfileStorePort {
  resolve(input: ResolveProfileInput): ResolvedCliProfile;
}
