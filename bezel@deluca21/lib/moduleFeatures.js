// Shared settings for a module, independent of its placement.
export const FEATURE_OPTIONS = {
    shelf: {shelfOpenOnDrag: ['Open when dragging files over the bar', true], shelfRemoveAfterDrop: ['Remove from shelf after a successful drop', true], shelfRemember: ['Remember shelf contents between openings', true], shelfCloseOutside: ['Close when clicking outside', true], shelfCloseAfterDrop: ['Close after dragging files out', true]},
    timer: {timerIcon: ['Show icon', true], timerName: ['Show current timer name', false], timerRemaining: ['Show remaining time', false]},
    shortcuts: {shortcutButtonIcon: ['Bar button: show icon', true], shortcutButtonName: ['Bar button: show name', true], shortcutIcons: ['Contents: show icons', true], shortcutNames: ['Contents: show names', true]},
    volume: {showOutputDevices: ['Output device selector', false]},
    microphone: {showInputDevices: ['Input device selector', true]},
    notifications: {embedded: ['Show notification list', false]},
    clock: {showSeconds: ['Show seconds', false], calendarTime: ['Time in calendar popout', true], calendarDate: ['Date in calendar popout', true], calendarGrid: ['Calendar grid', true], calendarNotifications: ['Notifications shortcut', true], weekNumbers: ['Week numbers', false]},
    calendar: {weekNumbers: ['Week numbers', false]},
    weather: {weatherCurrent: ['Current conditions', true], weatherForecast: ['Forecast', true], weatherLocation: ['Location', true], weatherStatus: ['Update status', false]},
    power: {powerIcons: ['Icons without labels', false], powerLock: ['Lock', true], powerSuspend: ['Suspend', true], powerLogout: ['Log out', true], powerRestart: ['Restart', true], powerOff: ['Power off', true]},
    performance: {metricCpu: ['CPU usage', true], metricMemory: ['Memory usage', true], metricTemperature: ['CPU temperature', false], metricGraphs: ['History graphs', true], metricProfiles: ['Power profiles', true]},
    media: {mediaSeek: ['Seek bar', false], mediaTime: ['Elapsed time and duration', true]},
};
export const NUMBER_OPTIONS = {performance: {refreshSeconds: ['Update interval (seconds)', 2, 1, 30]}, timer: {timerMinutes: ['Countdown (minutes)', 5, 1, 1440]}};
const flags = new Set(Object.values(FEATURE_OPTIONS).flatMap(options => Object.keys(options)));
export function normalizeFeatures(value = {}) {
    if (!value || typeof value !== 'object') value = {};
    const result = {};
    for (const key of flags) if (typeof value[key] === 'boolean') result[key] = value[key];
    for (const options of Object.values(NUMBER_OPTIONS)) for (const [key, [, fallback, min, max]] of Object.entries(options))
        if (Number.isFinite(value[key])) result[key] = Math.min(max, Math.max(min, Math.round(value[key] ?? fallback)));
    if (['copy', 'move', 'ask'].includes(value.shelfDragAction)) result.shelfDragAction = value.shelfDragAction;
    if (['list', 'rail'].includes(value.powerStyle)) result.powerStyle = value.powerStyle;
    if (['list', 'grid'].includes(value.shortcutLayout)) result.shortcutLayout = value.shortcutLayout;
    if (typeof value.shortcutLabel === 'string') result.shortcutLabel = value.shortcutLabel.trim().slice(0, 80);
    if (typeof value.shortcutIcon === 'string') result.shortcutIcon = value.shortcutIcon.trim().slice(0, 160);
    if (Array.isArray(value.shortcuts)) result.shortcuts = value.shortcuts.slice(0, 24).filter(item => item && ['app', 'folder', 'file', 'live-folder', 'command', 'action'].includes(item.type)).map(item => ({
        name: String(item.name || 'Shortcut').slice(0, 80), type: item.type, target: String(item.target || '').slice(0, 8192), showOutput: item.showOutput !== false,
    }));
    return result;
}
export function moduleFeatures(bar, id, overrides = {}) {
    const defaults = Object.fromEntries(Object.entries(FEATURE_OPTIONS[id] || {}).map(([key, [, value]]) => [key, value]));
    for (const [key, [, value]] of Object.entries(NUMBER_OPTIONS[id] || {})) defaults[key] = value;
    if (id === 'clock') defaults.showSeconds = bar._state.clockSeconds === true;
    // A module present on the bar has one shared set of options. Old cell
    // options must not silently override the settings displayed in its editor.
    const shared = bar._state.modules.find(item => item.id === id);
    return {...defaults, ...(shared || overrides)};
}
