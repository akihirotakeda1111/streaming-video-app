// @ts-check

/** Reject CLI options before any live command is dispatched. @param {readonly string[]} identifiers */
export function validateAlarmIdentifiers(identifiers) {
  if (
    !identifiers.length ||
    identifiers.some(
      (value) =>
        typeof value !== 'string' ||
        !value.trim() ||
        value !== value.trim() ||
        value.startsWith('-'),
    )
  ) {
    throw new Error('E2E_ALARM_IDENTIFIERS must contain non-option alarm names')
  }
}
