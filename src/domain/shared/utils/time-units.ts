/**
 * Time unit conversion constants — SSoT for the entire codebase.
 *
 * Do NOT redefine SECONDS_PER_MINUTE, MINUTES_PER_HOUR, MS_PER_SECOND,
 * MS_PER_MINUTE, or MS_PER_HOUR locally in any module. Import from here.
 *
 * Rule 30: domain constants used in 2+ files must live in a shared module.
 */

export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
export const MS_PER_HOUR = MINUTES_PER_HOUR * MS_PER_MINUTE;
export const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;
