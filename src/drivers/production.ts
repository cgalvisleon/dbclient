import { ConnectionConfig, FieldSpec } from './types';

const PRODUCTION_SECTION = 'Production';

/** Minutes a production session lasts when the form leaves the field empty. */
export const DEFAULT_SESSION_MINUTES = 30;

/**
 * Form fields shared by every engine: a production connection only opens through an explicit
 * Connect, and is closed after `sessionMinutes` (0 = no limit).
 */
export function productionFields(): FieldSpec[] {
  return [
    {
      key: 'production',
      label: 'Production connection',
      kind: 'checkbox',
      default: false,
      section: PRODUCTION_SECTION,
      hint: 'Never connects on its own (expanding the tree, running a query): use Connect on the connection.',
    },
    {
      key: 'sessionMinutes',
      label: 'Session time (minutes)',
      kind: 'number',
      default: DEFAULT_SESSION_MINUTES,
      showWhen: { field: 'production', values: [true] },
      section: PRODUCTION_SECTION,
      hint: 'Disconnects after this time; connect again to go on. 0 = no limit.',
    },
  ];
}

export function isProduction(config: ConnectionConfig): boolean {
  return config.options.production === true;
}

/** Session length in milliseconds of a production connection; undefined when it has no limit. */
export function sessionLimitMs(config: ConnectionConfig): number | undefined {
  if (!isProduction(config)) {
    return undefined;
  }
  const raw = config.options.sessionMinutes;
  const minutes = raw === undefined || raw === '' ? DEFAULT_SESSION_MINUTES : Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined;
}
