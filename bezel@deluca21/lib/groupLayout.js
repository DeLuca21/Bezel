import {moduleType} from './moduleIdentity.js';
import {normalizeFeatures} from './moduleFeatures.js';
// Pure layout data shared by the shell and settings. No dashboard dependencies.
export const GROUP_ITEMS = {
    shelf: {title: 'File shelf', icon: 'folder-download-symbolic'},
    shortcuts: {title: 'Shortcuts', icon: 'emblem-favorite-symbolic'},
    timer: {title: 'Timer / stopwatch', icon: 'alarm-symbolic'},
    devices: {title: 'Device batteries', icon: 'battery-symbolic'},
    input: {title: 'Sound input', icon: 'audio-input-microphone-symbolic'},
    notifications: {title: 'Notifications', icon: 'preferences-system-notifications-symbolic', action: true},
    volume: {title: 'Volume', icon: 'audio-volume-high-symbolic'},
    output: {title: 'Sound output', icon: 'audio-speakers-symbolic'},
    network: {title: 'Wi-Fi', icon: 'network-wireless-symbolic'},
    bluetooth: {title: 'Bluetooth', icon: 'bluetooth-symbolic'},
    brightness: {title: 'Brightness', icon: 'display-brightness-symbolic'},
    microphone: {title: 'Microphone', icon: 'audio-input-microphone-symbolic'},
    battery: {title: 'Battery', icon: 'battery-symbolic'},
    clock: {title: 'Time', icon: 'appointment-soon-symbolic'},
    date: {title: 'Date', icon: 'x-office-calendar-symbolic'},
    calendar: {title: 'Calendar', icon: 'x-office-calendar-symbolic'},
    weather: {title: 'Weather', icon: 'weather-few-clouds-symbolic'},
    power: {title: 'Power', icon: 'system-shutdown-symbolic', action: true},
    screenshot: {title: 'Screenshot', icon: 'camera-photo-symbolic', action: true},
    media: {title: 'Media', icon: 'audio-x-generic-symbolic'},
    clipboard: {title: 'Clipboard', icon: 'edit-paste-symbolic'},
    keyboard: {title: 'Keyboard', icon: 'input-keyboard-symbolic'},
    performance: {title: 'Performance', icon: 'power-profile-balanced-symbolic'},
    vpn: {title: 'VPN', icon: 'network-vpn-symbolic'},
    dnd: {title: 'Do Not Disturb', icon: 'notifications-disabled-symbolic'},
    nightlight: {title: 'Night Light', icon: 'night-light-symbolic'},
    dark: {title: 'Dark style', icon: 'weather-clear-night-symbolic'},
    settings: {title: 'Settings', icon: 'preferences-system-symbolic', action: true},
    apps: {title: 'App launcher', icon: 'view-app-grid-symbolic', action: true},
    awake: {title: 'Keep awake', icon: 'caffeine-cup-full-symbolic'},
    logo: {title: 'Applications', icon: 'view-app-grid-symbolic', action: true},
    dashboard: {title: 'Dashboard', icon: 'view-paged-symbolic', action: true},
    workspaces: {title: 'Workspaces', icon: 'view-paged-symbolic'},
    window: {title: 'Focused app', icon: 'focus-windows-symbolic'},
};
const array = value => Array.isArray(value) ? value : [];
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;
export function normalizeGroupLayout(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.blocks)) return null;
    const keys = new Set();
    const devices = new Set();
    let sequence = 0;
    const key = input => {
        let id = typeof input === 'string' && /^[\w-]{1,60}$/.test(input) ? input : `item-${++sequence}`;
        while (keys.has(id)) id = `item-${++sequence}`;
        keys.add(id); return id;
    };
    const row = input => ({type: 'row', id: key(input?.id), cells: array(input?.cells).slice(0, 4).flatMap(cell => {
        if (typeof cell?.module !== 'string' || !Object.hasOwn(GROUP_ITEMS, cell.module)) return [];
        if (['output', 'network', 'bluetooth'].includes(cell.module)) {
            if (devices.has(cell.module)) return [];
            devices.add(cell.module);
        }
        return [{id: key(cell.id), module: cell.module, ...(typeof cell.instance === 'string' && moduleType(cell.instance) === cell.module ? {instance: cell.instance} : {}), title: cell.title === true,
            view: cell.view === 'action' && GROUP_ITEMS[cell.module].action ? 'action' : 'full',
            options: {...normalizeFeatures(cell.options), ...Object.fromEntries(['showIcon', 'showValue', 'showArt', 'popIcon', 'popValue', 'brightIcon', 'brightValue', 'showMute', 'showToggle'].filter(key => typeof cell.options?.[key] === 'boolean').map(key => [key, cell.options[key]]))},
            span: bounded(cell.span ?? 1, 1, 1, 3)}];
    })});
    return {version: 1, width: bounded(value.width ?? 420, 420, 280, 900),
        spacing: bounded(value.spacing ?? 10, 10, 0, 32), hideUnavailable: value.hideUnavailable !== false,
        blocks: value.blocks.slice(0, 24).flatMap(block => {
            if (block?.type === 'row') return [row(block)];
            if (block?.type !== 'tabs') return [];
            return [{type: 'tabs', id: key(block.id), tabs: array(block.tabs).slice(0, 8).map((tab, index) => ({
                id: key(tab?.id), title: String(tab?.title || `Tab ${index + 1}`).slice(0, 40),
                rows: array(tab?.rows).slice(0, 16).map(row),
            }))}];
        })};
}
export const groupRows = layout => layout.blocks.flatMap(block => block.type === 'row' ? [block] : block.tabs.flatMap(tab => tab.rows));
export function newLayoutId(layout, prefix = 'item') {
    const text = JSON.stringify(layout);
    let n = 1;
    while (text.includes(`"${prefix}-${n}"`)) n++;
    return `${prefix}-${n}`;
}
export function moveGroupCell(layout, id, rowId, beforeId = null) {
    const next = JSON.parse(JSON.stringify(layout));
    const rows = groupRows(next);
    const source = rows.find(row => row.cells.some(cell => cell.id === id));
    const target = rows.find(row => row.id === rowId);
    if (!source || !target || (source === target && beforeId === id) || (target !== source && target.cells.length >= 4)) return next;
    const cell = source.cells.find(item => item.id === id);
    source.cells = source.cells.filter(item => item.id !== id);
    const at = target.cells.findIndex(item => item.id === beforeId);
    target.cells.splice(at < 0 ? target.cells.length : at, 0, cell);
    return next;
}
export function groupLayoutPreset(name, members = []) {
    const row = (...modules) => ({type: 'row', cells: modules.filter(id => Object.hasOwn(GROUP_ITEMS, moduleType(id))).map(id => ({module: moduleType(id), ...(id !== moduleType(id) ? {instance: id} : {})}))});
    const tab = (title, ...modules) => ({title, rows: [row(...modules)]});
    let blocks;
    if (name === 'quick') blocks = [row('volume'), {type: 'tabs', tabs: [tab('Output', 'output'), tab('Wi-Fi', 'network'), tab('Bluetooth', 'bluetooth')]}, row('brightness')];
    else if (name === 'clock') blocks = [row('clock', 'date'), row('calendar'), row('power', 'screenshot')];
    else if (name === 'blank') blocks = [];
    else {
        const ids = [...new Set(members.filter(id => Object.hasOwn(GROUP_ITEMS, moduleType(id))))];
        blocks = name === 'tabs' ? [{type: 'tabs', tabs: ids.map(id => tab(GROUP_ITEMS[moduleType(id)].title, id))}]
            : ids.map(id => row(id));
    }
    return normalizeGroupLayout({blocks});
}
