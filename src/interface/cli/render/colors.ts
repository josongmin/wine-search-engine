/**
 * Zero-dependency ANSI color helpers for the CLI.
 *
 * Honors NO_COLOR (https://no-color.org) and disables coloring when stdout is
 * not a TTY (piped/redirected), so machine-consumed output stays plain.
 *
 * SGR escape sequences are kept as named string constants (not numeric codes)
 * so there are no magic numbers and the intent reads clearly.
 */
const ESC = '[';
const RESET_INTENSITY = `${ESC}22m`; // closes bold/dim
const RESET_FG = `${ESC}39m`; // closes any foreground color

const SGR = {
  bold: [`${ESC}1m`, RESET_INTENSITY],
  dim: [`${ESC}2m`, RESET_INTENSITY],
  red: [`${ESC}31m`, RESET_FG],
  green: [`${ESC}32m`, RESET_FG],
  yellow: [`${ESC}33m`, RESET_FG],
  blue: [`${ESC}34m`, RESET_FG],
  magenta: [`${ESC}35m`, RESET_FG],
  cyan: [`${ESC}36m`, RESET_FG],
  gray: [`${ESC}90m`, RESET_FG],
} as const;

const ENABLED = process.env['NO_COLOR'] === undefined && process.stdout.isTTY;

function paint(open: string, close: string): (s: string) => string {
  if (!ENABLED) return (s) => s;
  return (s) => `${open}${s}${close}`;
}

type ColorName = keyof typeof SGR;
type ColorFns = { readonly [K in ColorName]: (s: string) => string };

export const color: ColorFns = Object.fromEntries(
  (Object.entries(SGR) as ReadonlyArray<readonly [ColorName, readonly [string, string]]>).map(
    ([name, [open, close]]) => [name, paint(open, close)],
  ),
) as ColorFns;
