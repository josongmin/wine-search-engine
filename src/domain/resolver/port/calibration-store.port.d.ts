import type { QueryClass } from '../../shared/types/index.js';
/**
 * Parameters for a specific calibration method trained on historical
 * resolution data, per RFC-006 §6.
 */
export interface CalibrationParams {
    /** The calibration method used. */
    readonly method: 'platt' | 'isotonic' | 'temperature';
    /** The query class these parameters are trained for. */
    readonly queryClass: QueryClass;
    /**
     * Method-specific parameters.
     * - Platt: `{ a: number, b: number }`
     * - Temperature: `{ temperature: number }`
     * - Isotonic: implementation-specific lookup table encoding.
     */
    readonly params: Readonly<Record<string, number>>;
    /** When these parameters were last trained/fitted. */
    readonly trainedAt: Date;
    /** Expected calibration error (ECE) measured at training time, in [0, 1]. */
    readonly ece: number;
}
/**
 * Port for persisting and retrieving score calibration parameters.
 *
 * Infrastructure adapters store calibration models per query class so
 * that the resolver can convert raw match scores into calibrated
 * probabilities.
 */
export interface CalibrationStore {
    /**
     * Retrieves calibration parameters for a given query class.
     *
     * @param queryClass - The query class to retrieve parameters for.
     * @returns The calibration parameters, or `null` if none have been trained.
     */
    getCalibrationParams(queryClass: QueryClass): Promise<CalibrationParams | null>;
    /**
     * Persists calibration parameters for a given query class.
     *
     * @param queryClass - The query class these parameters apply to.
     * @param params - The calibration parameters to save.
     */
    save(queryClass: QueryClass, params: CalibrationParams): Promise<void>;
}
//# sourceMappingURL=calibration-store.port.d.ts.map