/**
 * TEMP MONITORING KILL SWITCH (Oct 19 2026, owner directive — temporary).
 *
 * While TEMP_MONITORING_DISABLED is true, the ENTIRE live temperature
 * monitoring feature is bypassed:
 *   - LiveTempBadge is not rendered (the dashboard floating temp badge)
 *   - No Inkbird BLE connect attempts (the badge owned the only auto-connect)
 *   - No RxTempLogs reads or writes (boot sync, priority sync, resume resync,
 *     WS subscription, sidebar dispatcher badges, boot temp load)
 *   - Admin "Temp Logs" and "BLE Diag" tabs are hidden
 *   - CoolerTempReader (post-complete fridge temp capture) never mounts
 *   - Fridge temp dialog dispatches are suppressed
 *
 * The ONLY temperature UI kept: the blue-green fridge-item badge on the
 * stop cards (StopCardHeader), rendered as a static fridge-item indicator
 * with no live/stored temperature values.
 *
 * To re-enable the feature, set TEMP_MONITORING_DISABLED to false.
 */
export const TEMP_MONITORING_DISABLED = true;
export const isTempMonitoringEnabled = () => !TEMP_MONITORING_DISABLED;
