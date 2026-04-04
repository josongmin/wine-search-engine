import type { ThresholdProfileV1 } from '../model/threshold-profile.js';

/**
 * Port for persisting and retrieving threshold profiles.
 *
 * Infrastructure adapters (e.g. Postgres, in-memory, config file) implement
 * this interface to supply threshold profiles to the planner.
 */
export interface ThresholdStore {
  /**
   * Retrieves a threshold profile by its unique ID.
   * @param id - The profile identifier.
   * @returns The profile, or `null` if not found.
   */
  getProfile(id: string): Promise<ThresholdProfileV1 | null>;

  /**
   * Retrieves the default threshold profile.
   * Implementations must guarantee this never returns null.
   */
  getDefault(): Promise<ThresholdProfileV1>;

  /**
   * Persists a threshold profile, overwriting any existing profile with the same ID.
   * @param profile - The profile to save.
   */
  save(profile: ThresholdProfileV1): Promise<void>;
}
