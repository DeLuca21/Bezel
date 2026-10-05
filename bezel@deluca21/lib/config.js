import {moduleType} from './moduleIdentity.js';
import {normalizeFeatures} from './moduleFeatures.js';
import {normalizeGroupLayout} from './groupLayout.js';
import {packRows, spanOf} from './dashboardGeometry.js';
import {LOGIN_THEMES} from './loginMotion.js';

// Shared by the shell and preferences. Never let a hand-edited config break enable().
export const PLACES = {
    logo: 'start', workspaces: 'start', window: 'center', dashboard: 'center',
    clock: 'center', date: 'end', weather: 'end', apps: 'start', volume: 'end',
    network: 'end', battery: 'end', power: 'end', spacer: 'center',
    screenshot: 'end', dnd: 'end', performance: 'end', vpn: 'end', settings: 'end',
    nightlight: 'end', dark: 'end', media: 'end', microphone: 'end', clipboard: 'end',
    keyboard: 'end', awake: 'end', indicators: 'end', output: 'end', bluetooth: 'end', brightness: 'end', notifications: 'end', shelf: 'end', shortcuts: 'end', timer: 'end', devices: 'end', input: 'end',
};
const OPTIONAL_MODULES = ['screenshot', 'dnd', 'performance', 'vpn', 'settings', 'nightlight', 'dark', 'media', 'microphone', 'clipboard', 'keyboard', 'awake', 'indicators', 'output', 'bluetooth', 'brightness', 'notifications', 'shelf', 'shortcuts', 'timer', 'devices', 'input'];
export const DEFAULT_GROUPS = {
    clock: 'clock', date: 'clock', volume: 'status', network: 'status', battery: 'status',
};
export const DATE_FORMATS = {
    weekday: {label: 'Weekday · Fri', format: '%a'},
    short: {label: 'Short · Fri 25', format: '%a %e'},
    medium: {label: 'Medium · Fri 25 Sep', format: '%a %e %b'},
    long: {label: 'Long · Friday, 25 September', format: '%A, %e %B'},
    numeric: {label: 'Numeric · 25/09', format: '%d/%m'},
    iso: {label: 'ISO · 2026-09-25', format: '%Y-%m-%d'},
};
export const timePattern = (twelve, seconds) => twelve
    ? (seconds ? '%I:%M:%S %p' : '%I:%M %p')
    : (seconds ? '%H:%M:%S' : '%H:%M');
export const barDateFormat = (bar, settings) => DATE_FORMATS[bar?.dateFormat]
    ? bar.dateFormat
    : settingChoice(settings, 'date-format', 'medium', Object.keys(DATE_FORMATS));
export const barTimeFormat = (bar, gnomeFormat = '24h') =>
    bar?.timeFormat === '12h' || bar?.timeFormat === '24h' ? bar.timeFormat : (gnomeFormat === '12h' ? '12h' : '24h');
export const EDGES = ['left', 'top', 'right', 'bottom'];
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const settingFlag = (settings, key, fallback = false) =>
    settings.settings_schema.has_key(key) ? settings.get_boolean(key) : fallback;
export const settingChoice = (settings, key, fallback, allowed) => {
    if (!settings.settings_schema.has_key(key))
        return fallback;
    const value = settings.get_string(key);
    return allowed.includes(value) ? value : fallback;
};
const number = (value, fallback, min, max) =>
    Number.isFinite(Number(value)) ? clamp(Math.round(Number(value)), min, max) : fallback;
const HEX = /^#[0-9a-f]{6}$/i;
export const hexColor = value => HEX.test(String(value ?? '')) ? String(value).toLowerCase() : '';

// Screen-border shadow is the frame's Cairo glow. Bar shadows sit on top of
// that opening and look wrong, so a framed desktop keeps bar glow at 0.
export function barShadowDepth(shadow, frameOn) {
    if (frameOn)
        return 0;
    return number(shadow, 0, 0, 24);
}

export const PANEL_MODULES = new Set([
    'shelf', 'timer', 'shortcuts', 'devices', 'input', 'notifications', 'clock', 'date', 'weather', 'volume', 'network', 'battery', 'power', 'dashboard',
    'performance', 'vpn', 'settings', 'window', 'apps', 'media', 'microphone', 'clipboard', 'keyboard',
]);
const HOVER_SETTING = {
    clock: 'clock-hover', date: 'clock-hover',
    volume: 'status-hover', network: 'status-hover', battery: 'status-hover',
    power: 'power-button-hover', dashboard: 'dashboard-hover',
};
const IN_PLACE = new Set(['screenshot', 'dnd', 'nightlight', 'dark', 'awake']);
const VALUE_KEYS = new Set(['showValue', 'brightValue', 'showArt', 'popValue']);

export function hoverEnabled(module, group, settings) {
    if (group && typeof group.hover === 'boolean')
        return group.hover;
    if (module && typeof module.hover === 'boolean')
        return module.hover;
    const key = HOVER_SETTING[moduleType(module?.id)];
    if (key)
        return settingFlag(settings, key, true);
    if (module?.id === 'apps')
        return true;
    if (IN_PLACE.has(moduleType(module?.id)))
        return false;
    return PANEL_MODULES.has(moduleType(module?.id));
}

export const MODULE_SWITCHES = {
    battery: [['showIcon', 'Icon'], ['showValue', 'Percentage']],
    weather: [['showIcon', 'Icon'], ['showValue', 'Temperature']],
    volume: [['showIcon', 'Icon'], ['showValue', 'Percentage']],
    network: [['showIcon', 'Icon'], ['showValue', 'Name']],
    vpn: [['showIcon', 'Icon'], ['showValue', 'Connection']],
    performance: [['showIcon', 'Icon'], ['showValue', 'Profile']],
    window: [['showIcon', 'Icon'], ['showValue', 'Window title']],
    media: [['showIcon', 'Icon'], ['showValue', 'Title'], ['showArt', 'Artwork']],
    microphone: [['showIcon', 'Icon'], ['showValue', 'Level']],
};

export function switchOn(module, bar, key) {
    if (typeof module?.[key] === 'boolean')
        return module[key];
    if (key === 'showValue' && moduleType(module?.id) === 'battery' && bar?.batteryPercentage)
        return true;
    if (key === 'popValue' && moduleType(module?.id) === 'network')
        return true;
    return !VALUE_KEYS.has(key);
}

export function moduleLook(module, bar) {
    const icon = switchOn(module, bar, 'showIcon');
    const value = switchOn(module, bar, 'showValue');
    const art = switchOn(module, bar, 'showArt');
    if (!icon && !value && !art)
        return {icon: true, value: false, art: false};
    return {icon, value, art};
}

export function sliderLayout(module, settings) {
    if (['edge', 'stack', 'drawer'].includes(module?.sliderStyle))
        return module.sliderStyle;
    return settingChoice(settings, 'slider-style', 'drawer', ['drawer', 'edge']) === 'edge' ? 'edge' : 'drawer';
}

export function powerLayout(module, settings) {
    if (module?.powerStyle === 'list' || module?.powerStyle === 'rail')
        return module.powerStyle;
    return settingChoice(settings, 'power-style', 'list', ['list', 'rail']);
}

export function powerDim(module, settings) {
    if (typeof module?.sessionDim === 'boolean')
        return module.sessionDim;
    return settingFlag(settings, 'session-dim');
}

export function groupFillColor(group, bar, theme) {
    const choice = group?.color;
    if (choice === 'plain')
        return '';
    if (choice === 'accent')
        return theme?.accent || '';
    if (choice === 'custom')
        return hexColor(group.custom);
    if (choice === 'theme' || (!choice && bar?.colourGroups))
        return theme?.group || theme?.accent || '';
    return '';
}

export function groupAppearance(group, bar) {
    return {
        padding: number(group?.padding ?? bar?.groupPadding ?? 16, 16, 0, 32),
        inset: number(group?.inset ?? bar?.groupInset ?? 4, 4, 0, 12),
        rounding: number(group?.rounding ?? bar?.groupRounding ?? 14, 14, 0, 48),
        opacity: number(group?.opacity ?? bar?.groupOpacity ?? 55, 55, 0, 100),
    };
}

// These presets affect the selected bar; pinned apps and other modules survive.
export function barAppearancePreset(bar, look) {
    if (!['frame', 'floating', 'minimal'].includes(look)) return bar;
    const framed = look === 'frame';
    const groups = barGroups(bar);
    const appGroup = bar.modules.find(item => item.id === 'apps')?.group;
    let groupId = appGroup || 'dock-apps';
    if (!appGroup) {
        let n = 2;
        while (groups.some(group => group.id === groupId)) groupId = `dock-apps-${n++}`;
        groups.push({id: groupId, name: 'Dock apps', place: 'center'});
    }
    return {...bar, kind: framed ? 'panel' : 'dock', margin: framed ? 0 : 16,
        length: 100, fitContent: true, sections: 'one', colourGroups: framed,
        barOpacity: look === 'minimal' ? 0 : 100, rounding: look === 'minimal' ? 0 : 20,
        groupPadding: framed ? 16 : 8, groupInset: 4, groupRounding: 14, groupOpacity: 55,
        modules: bar.modules.map(item => ['logo', 'apps'].includes(item.id)
            ? {...item, group: groupId, place: 'center'} : item),
        groups: groups.map(group => ({...group, color: framed ? (group.color === 'plain' ? 'theme' : group.color) : '',
            ...(group.id === groupId ? {place: 'center', padding: undefined, inset: undefined, rounding: undefined, opacity: undefined} : {})})),
    };
}

export function barTheme(theme, bar, frameOn) {
    if (frameOn || !bar?.ownColors)
        return theme;
    const surface = hexColor(bar.ownSurface);
    const accent = hexColor(bar.ownAccent);
    if (!surface && !accent)
        return theme;
    return {...theme, ...(surface ? {bg: surface, surface} : {}), ...(accent ? {accent} : {})};
}

// Extension icons used to follow a desktop switch. Keep them by placing one module, once.
export function adoptIndicators(settings) {
    const config = readConfig(settings);
    if (config.indicatorsPlaced)
        return false;
    const bars = readBars(settings);
    const next = {...config, indicatorsPlaced: true};
    if (settings.get_boolean('panel-indicators') && bars.length && !bars.some(bar => bar.modules.some(item => moduleType(item.id) === 'indicators'))) {
        const selected = settings.get_int('indicator-bar');
        let index = selected > 0 ? selected - 1 : bars.findIndex(bar => bar.edge !== 'left' && bar.edge !== 'right' && bar.kind !== 'dock');
        if (index < 0 || index >= bars.length)
            index = 0;
        next.bars = bars.map((bar, i) => i === index ? {
            ...bar,
            modules: [...bar.modules, {id: 'indicators', place: 'end', group: ''}],
        } : bar);
    }
    settings.set_string('config', JSON.stringify(next));
    return true;
}

// One stop control for a running recording. An existing screenshot module wins.
// Otherwise prefer a top panel, then any other panel, then the first dock.
// The button is temporary and always sits in that bar's trailing zone.
export function recordingStopHost(bars) {
    const list = Array.isArray(bars) ? bars : [];
    if (!list.length || list.some(bar => (bar.modules ?? []).some(item => moduleType(item.id) === 'screenshot')))
        return null;
    const rank = bar => {
        if (bar.kind !== 'dock' && bar.edge === 'top')
            return 0;
        if (bar.kind !== 'dock' && bar.edge === 'bottom')
            return 1;
        if (bar.kind !== 'dock')
            return 2;
        return 3;
    };
    let index = 0;
    for (let i = 1; i < list.length; i++)
        if (rank(list[i]) < rank(list[index]))
            index = i;
    const bar = list[index];
    return {index, place: 'end', edge: bar.edge, kind: bar.kind === 'dock' ? 'dock' : 'panel'};
}

export function readConfig(settings) {
    try {
        const value = JSON.parse(settings.get_string('config') || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
}

export function isSpacer(id) {
    return typeof id === 'string' && /^spacer(?:-[a-z0-9]{1,12})?$/.test(id);
}

export function nextSpacerId(modules) {
    const used = new Set((modules ?? []).map(item => item.id));
    if (!used.has('spacer'))
        return 'spacer';
    for (let i = 2; i <= 16; i++) {
        if (!used.has(`spacer-${i}`))
            return `spacer-${i}`;
    }
    return null;
}

export function spacerLabel(id) {
    const index = id === 'spacer' ? 1 : Number(/spacer-(\d+)/.exec(id)?.[1] ?? 1);
    return index > 1 ? `Empty space ${index}` : 'Empty space';
}

export function normalizeModules(list) {
    if (!Array.isArray(list))
        list = Object.keys(PLACES).filter(id => !['dashboard', 'apps', 'weather', 'date', 'spacer', ...OPTIONAL_MODULES].includes(id));
    const seen = new Set();
    return list.flatMap(item => {
        const id = typeof item === 'string' ? item : item?.id;
        if ((!Object.hasOwn(PLACES, moduleType(id)) && !isSpacer(id)) || seen.has(id))
            return [];
        seen.add(id);
        const spacer = isSpacer(id);
        return [{
            id,
            place: ['start', 'center', 'end'].includes(item?.place) ? item.place : PLACES[moduleType(id)] ?? 'center',
            group: normalizeGroup(id, item),
            ...(spacer ? {size: number(item?.size, 24, 8, 400)} : {}),
            ...moduleExtras(item),
        }];
    });
}

function moduleExtras(item) {
    if (!item || typeof item !== 'object')
        return {};
    const extra = normalizeFeatures(item);
    if (typeof item.hover === 'boolean')
        extra.hover = item.hover;
    for (const key of ['showIcon', 'showValue', 'showArt', 'brightIcon', 'brightValue', 'popIcon', 'popValue', 'sessionDim', 'showMute', 'showToggle'])
        if (typeof item[key] === 'boolean')
            extra[key] = item[key];
    if (['edge', 'stack', 'drawer'].includes(item.sliderStyle))
        extra.sliderStyle = item.sliderStyle;
    if (item.powerStyle === 'list' || item.powerStyle === 'rail')
        extra.powerStyle = item.powerStyle;
    if (['pills', 'numbers', 'icons'].includes(item.workspaceStyle))
        extra.workspaceStyle = item.workspaceStyle;
    return extra;
}

function normalizeGroup(id, item) {
    if (typeof item === 'object' && item && Object.hasOwn(item, 'group')) {
        const group = item.group;
        if (!group)
            return '';
        return typeof group === 'string' && /^[a-z][a-z0-9-]{0,24}$/.test(group) ? group : '';
    }
    return DEFAULT_GROUPS[id] ?? '';
}

// Explicit definitions retain empty groups; older layouts infer them from members.
export function barGroups(bar) {
    const groups = new Map();
    for (const group of Array.isArray(bar.groups) ? bar.groups : []) {
        if (typeof group?.id === 'string' && /^[a-z][a-z0-9-]{0,24}$/.test(group.id))
            groups.set(group.id, groupRecord(group));
    }
    for (const item of bar.modules ?? []) {
        if (item.group && !groups.has(item.group))
            groups.set(item.group, groupRecord({id: item.group, name: item.group[0].toUpperCase() + item.group.slice(1), place: item.place}));
    }
    for (const group of groups.values())
        group.place = ['start', 'center', 'end'].includes(group.place) ? group.place
            : bar.modules?.find(item => item.group === group.id)?.place ?? 'center';
    return [...groups.values()];
}

function groupRecord(group) {
    const record = {
        id: group.id,
        name: String(group.name || group.id).slice(0, 60),
        place: group.place,
    };
    if (typeof group.hover === 'boolean')
        record.hover = group.hover;
    if (['plain', 'theme', 'accent', 'custom'].includes(group.color))
        record.color = group.color;
    for (const [key, max] of [['padding', 32], ['inset', 12], ['rounding', 48], ['opacity', 100]])
        if (group[key] != null) record[key] = number(group[key], 0, 0, max);
    const popout = normalizeGroupLayout(group.popout);
    if (popout) record.popout = popout;
    if (group.face === 'single') record.face = 'single';
    if (typeof group.icon === 'string') record.icon = group.icon.slice(0, 100);
    if (group.clicks && typeof group.clicks === 'object')
        record.clicks = Object.fromEntries(Object.entries(group.clicks).filter(([id, mode]) => Object.hasOwn(PLACES, moduleType(id)) && ['group', 'direct', 'tab'].includes(mode)));
    const custom = hexColor(group.custom);
    if (custom)
        record.custom = custom;
    return record;
}

export function readBars(settings) {
    const config = readConfig(settings);
    const bars = Array.isArray(config.bars) && config.bars.length ? config.bars : [{}];
    return normalizeBars(bars);
}

export function normalizeBars(bars) {
    let indicatorsKept = false;
    return bars.slice(0, 4).map(value => {
        const bar = value && typeof value === 'object' ? value : {};
        const modules = normalizeModules(bar.modules);
        return {
            ...bar,
            edge: EDGES.includes(bar.edge) ? bar.edge : 'left',
            logoIcon: typeof bar.logoIcon === 'string' && bar.logoIcon.trim() ? bar.logoIcon.trim() : 'view-app-grid-symbolic',
            logoAction: ['launcher', 'overview', 'apps'].includes(bar.logoAction) ? bar.logoAction : 'launcher',
            kind: bar.kind === 'dock' ? 'dock' : 'panel',
            fitContent: bar.fitContent !== false,
            dockMinLength: number(bar.dockMinLength ?? 240, 240, 64, 10000),
            length: number(bar.length ?? 100, 100, 20, 100),
            margin: number(bar.margin ?? 0, 0, 0, 64),
            rounding: number(bar.rounding ?? 20, 20, 0, 48),
            barShadow: number(bar.barShadow ?? 8, 8, 0, 24),
            runningApps: bar.runningApps !== false,
            appSpacing: number(bar.appSpacing ?? (bar.kind === 'dock' ? 12 : 8), 10, 0, 32),
            appsLength: number(bar.appsLength ?? 0, 0, 0, 2400),
            appsCap: bar.appsCap === true,
            batteryPercentage: bar.batteryPercentage === true,
            appHover: ['none', 'lift', 'both'].includes(bar.appHover) ? bar.appHover : 'highlight',
            appPress: bar.appPress !== false,
            appFocus: ['none', 'background', 'both'].includes(bar.appFocus) ? bar.appFocus : 'line',
            appClick: ['activate', 'minimize', 'previews'].includes(bar.appClick) ? bar.appClick : 'cycle',
            thickness: number(bar.thickness ?? 56, 56, 44, 88),
            iconSize: number(bar.iconSize ?? 22, 22, 12, 40),
            reserveSpace: bar.reserveSpace !== false,
            reserveOffset: number(bar.reserveOffset ?? 0, 0, 0, 64),
            autohide: bar.autohide === true,
            sections: bar.sections === 'pills' ? 'pills' : 'one',
            colourGroups: bar.colourGroups === true,
            barOpacity: number(bar.barOpacity ?? 100, 100, 0, 100),
            groupPadding: number(bar.groupPadding ?? 16, 16, 0, 32),
            groupInset: number(bar.groupInset ?? 4, 4, 0, 12),
            groupRounding: number(bar.groupRounding ?? 14, 14, 0, 48),
            groupOpacity: number(bar.groupOpacity ?? 55, 55, 0, 100),
            appIndicator: ['dot', 'none'].includes(bar.appIndicator) ? bar.appIndicator : 'line',
            ownColors: bar.ownColors === true,
            ownSurface: hexColor(bar.ownSurface),
            ownAccent: hexColor(bar.ownAccent),
            modules,
            groups: barGroups({...bar, modules}),
            pinned: [...new Set((Array.isArray(bar.pinned) ? bar.pinned : [])
                .filter(id => typeof id === 'string' && id.startsWith('app:') && id.length > 4))],
        };
    }).map(bar => {
        const modules = bar.modules.filter(item => {
            if (moduleType(item.id) !== 'indicators')
                return true;
            if (indicatorsKept)
                return false;
            indicatorsKept = true;
            return true;
        });
        if (modules.length === bar.modules.length)
            return bar;
        return {...bar, modules, groups: barGroups({...bar, modules})};
    });
}

export function saveBars(settings, bars) {
    settings.set_string('config', JSON.stringify({...readConfig(settings), bars}));
}

export function readState(settings) {
    return {
        borderWidth: settings.get_int('frame-width'),
        radius: settings.get_int('frame-radius'),
        border: settings.get_boolean('show-frame'),
        edgePanels: settings.get_boolean('edge-panels'),
        powerHover: settings.get_boolean('power-hover'),
        statusHover: settings.get_boolean('status-hover'),
        clockHover: settings.get_boolean('clock-hover'),
        powerButtonHover: settings.get_boolean('power-button-hover'),
        dashboardHover: settings.get_boolean('dashboard-hover'),
        hoverDelay: settings.get_int('hover-delay'),
        animationDuration: settings.get_int('animation-duration'),
        loginAnimationTheme: settingChoice(settings, 'login-animation-theme', 'liquid', LOGIN_THEMES.map(([id]) => id)),
        loginAnimationSpeed: settings.settings_schema.has_key('login-animation-speed') ? settings.get_int('login-animation-speed') : 100,
        shadow: settings.get_int('frame-shadow'),
        dashboardWidth: settings.get_int('dashboard-width'),
        launcherWidth: settings.get_int('launcher-width'),
        editMode: settings.get_boolean('edit-mode'),
        powerStyle: settingChoice(settings, 'power-style', 'list', ['list', 'rail']),
        sliderStyle: settingChoice(settings, 'slider-style', 'drawer', ['drawer', 'edge']),
        sessionDim: settingFlag(settings, 'session-dim'),
        bars: readBars(settings),
    };
}

export const DASHBOARD_WIDGETS = {
    identity: {label: 'Profile', tabs: ['overview']},
    calendar: {label: 'Calendar', tabs: ['overview']},
    media: {label: 'Media', tabs: ['overview', 'media']},
    actions: {label: 'Shortcuts', tabs: ['overview']},
    weather: {label: 'Weather', tabs: ['overview']},
    cpu: {label: 'CPU', tabs: ['performance']},
    memory: {label: 'Memory', tabs: ['performance']},
    temp: {label: 'Temperature', tabs: ['performance']},
    workspaces: {label: 'Workspaces', tabs: ['workspaces']},
    forecast: {label: 'Forecast', tabs: ['overview']},
    gpu: {label: 'GPU', tabs: ['performance']},
    disk: {label: 'Disk', tabs: ['performance']},
    network: {label: 'Network', tabs: ['performance']},
};

export function defaultDashboard(weather = true) {
    return {
        overview: [
            [{id: 'identity', span: 1}, {id: 'calendar', span: 1}],
            [{id: 'media', span: 2}],
            [{id: 'actions', span: 1}],
            ...(weather ? [[{id: 'weather', span: 2}]] : []),
        ],
        media: [[{id: 'media', span: 2}]],
        performance: [[{id: 'cpu', span: 1}, {id: 'memory', span: 1}, {id: 'temp', span: 1}]],
        workspaces: [[{id: 'workspaces', span: 2}]],
    };
}

export const DASHBOARD_PAGES = [
    {id: 'overview', title: 'Dashboard'}, {id: 'media', title: 'Media'},
    {id: 'performance', title: 'Performance'}, {id: 'workspaces', title: 'Workspaces'},
];

export function dashboardPages(layout) {
    return layout._pages ?? DASHBOARD_PAGES.map(page => ({...page}));
}

function normalizeDashboardCell(item, seen) {
    if (item?.gap === true) {
        const cell = {gap: true, span: spanOf(item)};
        if (typeof item.id === 'string' && /^gap-[a-z0-9-]{1,24}$/.test(item.id))
            cell.id = item.id;
        return [cell];
    }
    const id = item?.id;
    if (!Object.hasOwn(DASHBOARD_WIDGETS, id) || seen.has(id))
        return [];
    seen.add(id);
    const cell = {id, span: spanOf(item)};
    if (Number.isFinite(item.height) && item.height > 0)
        cell.height = Math.round(Math.max(32, Math.min(720, item.height)));
    return [cell];
}

export function readDashboard(settings) {
    const saved = readConfig(settings).dashboard;
    const fallback = defaultDashboard(settingFlag(settings, 'weather-dashboard', true));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved))
        return fallback;
    const seenPages = new Set();
    const pages = (Array.isArray(saved._pages) ? saved._pages : DASHBOARD_PAGES).flatMap(page => {
        const id = page?.id;
        if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id) ||
            ['constructor', 'prototype'].includes(id) || seenPages.has(id))
            return [];
        seenPages.add(id);
        return [{id, title: String(page.title || 'Page').trim().slice(0, 40) || 'Page'}];
    });
    if (!pages.length)
        pages.push({...DASHBOARD_PAGES[0]});
    const layout = {_pages: pages};
    for (const {id: key} of pages) {
        const items = Array.isArray(saved[key]) ? saved[key]
            : Array.isArray(saved._pages) ? [] : fallback[key] ?? [];
        const seen = new Set();
        const source = Array.isArray(items) ? items : [];
        const rows = source.some(item => Array.isArray(item)) ? source
            : packRows(source.map(item => item?.ownRow === true ? {...item, ownRow: true} : item));
        layout[key] = rows.flatMap(row => {
            if (!Array.isArray(row))
                return [];
            const cells = row.flatMap(item => normalizeDashboardCell(item, seen));
            return cells.length ? [cells] : [];
        });
    }
    return layout;
}

export function saveDashboard(settings, dashboard) {
    settings.set_string('config', JSON.stringify({...readConfig(settings), dashboard}));
}

export const PRESET_IDS = ['caelestia', 'panel', 'dock', 'hybrid', 'islands', 'split'];

const stableValue = value => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
    return value;
};

const presetOptions = id => {
    const shell = id === 'caelestia';
    return {
        showFrame: shell,
        indicatorBar: 0,
        powerStyle: shell ? 'rail' : 'list',
        sliderStyle: shell ? 'edge' : 'drawer',
        powerPosition: shell ? 'right' : 'icon',
        sessionDim: shell,
        powerButtonHover: !shell,
        indicatorIconSize: shell ? 16 : 22,
        indicatorSpacing: shell ? 16 : 14,
        superLauncher: !shell,
    };
};

// Pins, logo, and a running indicator ride along; everything else is the preset.
function barsForPreset(settings, id, favorites = []) {
    const config = readConfig(settings);
    const bars = readBars(settings);
    const pins = [...new Set(bars.flatMap(bar => bar.pinned))];
    const source = bars.find(bar => bar.modules.some(module => module.id === 'logo')) ?? bars[0];
    const indicator = bars.flatMap(bar => bar.modules).find(module => moduleType(module.id) === 'indicators');
    const next = presetBars(id, Array.isArray(config.bars) ? pins : favorites.map(app => `app:${app}`)).map((bar, index) => {
        const current = bars[index];
        const carried = current?.modules.some(module => module.id === 'apps') ? current.runningApps : source?.runningApps;
        return {...bar,
            logoIcon: source?.logoIcon, logoAction: source?.logoAction, appClick: source?.appClick,
            runningApps: bar.modules.some(module => module.id === 'apps') ? carried !== false : false};
    });
    if (indicator && next[0])
        next[0].modules = [...next[0].modules, {id: 'indicators', place: indicator.place || 'end', group: ''}];
    return next;
}

function presetMatches(settings, id) {
    const config = readConfig(settings);
    const current = Array.isArray(config.bars) && config.bars.length ? config.bars : [{}];
    if (JSON.stringify(stableValue(normalizeBars(current))) !== JSON.stringify(stableValue(normalizeBars(barsForPreset(settings, id)))))
        return false;
    const options = presetOptions(id);
    if (settings.get_boolean('show-frame') !== options.showFrame) return false;
    if (settings.get_int('indicator-bar') !== options.indicatorBar) return false;
    const has = key => !settings.settings_schema || settings.settings_schema.has_key?.(key);
    if (has('power-style') && (settings.get_string('power-style') !== options.powerStyle
        || settings.get_string('slider-style') !== options.sliderStyle
        || settings.get_string('power-position') !== options.powerPosition
        || settings.get_boolean('session-dim') !== options.sessionDim
        || settings.get_boolean('power-button-hover') !== options.powerButtonHover))
        return false;
    if (has('indicator-icon-size') && (settings.get_int('indicator-icon-size') !== options.indicatorIconSize
        || settings.get_int('indicator-spacing') !== options.indicatorSpacing))
        return false;
    if (has('super-launcher') && settings.get_boolean('super-launcher') !== options.superLauncher)
        return false;
    return true;
}

// The layout currently on screen, when it is still an untouched built-in preset.
export function builtInLayout(settings) {
    const mode = readConfig(settings).layoutMode;
    const ids = PRESET_IDS.includes(mode) ? [mode] : PRESET_IDS;
    return ids.find(id => presetMatches(settings, id)) ?? null;
}

export function presetBars(id, pinned = []) {
    const modules = (ids, places = {}) => ids.map(key => ({id: key, place: places[key] ?? PLACES[key]}));
    const dockModules = () => modules(['logo', 'apps'], {apps: 'center'});
    const base = {thickness: 56, iconSize: 22, reserveSpace: true, reserveOffset: 8, pinned};
    if (id === 'panel')
        return [{...base, edge: 'bottom', modules: modules(['logo', 'apps', 'workspaces', 'clock', 'volume', 'network', 'battery', 'power'])}];
    if (id === 'dock')
        return [{...base, edge: 'bottom', kind: 'dock', margin: 12, thickness: 64, iconSize: 36,
            modules: dockModules(), rounding: 24, runningApps: true}];
    if (id === 'hybrid')
        return [
            {...base, edge: 'top', thickness: 48, pinned: [], modules: modules(['logo', 'workspaces', 'clock', 'dashboard', 'volume', 'network', 'battery', 'power'])},
            {...base, edge: 'bottom', kind: 'dock', margin: 12, thickness: 64, iconSize: 36, modules: dockModules(), rounding: 24},
        ];
    if (id === 'islands')
        return [{...base, edge: 'top', sections: 'pills', colourGroups: true,
            modules: modules(['logo', 'workspaces', 'clock', 'dashboard', 'volume', 'network', 'battery', 'power'])}];
    if (id === 'split')
        return [
            {...base, edge: 'top', thickness: 48, ownColors: true, ownSurface: '#2a273f', ownAccent: '#ebbcba', pinned: [],
                modules: modules(['logo', 'workspaces', 'clock', 'dashboard', 'volume', 'network', 'battery', 'power'])},
            {...base, edge: 'bottom', kind: 'dock', margin: 12, thickness: 64, iconSize: 36, rounding: 24,
                ownColors: true, ownSurface: '#1f1d2e', ownAccent: '#9ccfd8', modules: dockModules()},
        ];
    return [{...base, edge: 'left', modules: modules(['logo', 'workspaces', 'apps', 'window', 'dashboard', 'clock', 'volume', 'network', 'battery', 'power'])}];
}

// Built-in layouts replace geometry; named profiles retain complete custom layouts.
export function applyPreset(settings, id, favorites = []) {
    if (!PRESET_IDS.includes(id)) return;
    requestLayoutTransition(settings);
    const config = readConfig(settings);
    settings.set_string('previous-layout', JSON.stringify({config: settings.get_string('config'), frame: settings.get_boolean('show-frame'), indicatorBar: settings.get_int('indicator-bar')}));
    const options = presetOptions(id);
    settings.set_string('config', JSON.stringify({...config, layoutMode: id, bars: barsForPreset(settings, id, favorites)}));
    settings.set_boolean('show-frame', options.showFrame);
    settings.set_int('indicator-bar', options.indicatorBar);
    if (!settings.settings_schema || settings.settings_schema.has_key?.('power-style')) {
        settings.set_string('power-style', options.powerStyle);
        settings.set_string('slider-style', options.sliderStyle);
        settings.set_string('power-position', options.powerPosition);
        settings.set_boolean('session-dim', options.sessionDim);
        settings.set_boolean('power-button-hover', options.powerButtonHover);
    }
    if (!settings.settings_schema || settings.settings_schema.has_key?.('indicator-icon-size')) {
        settings.set_int('indicator-icon-size', options.indicatorIconSize);
        settings.set_int('indicator-spacing', options.indicatorSpacing);
    }
    if (!settings.settings_schema || settings.settings_schema.has_key?.('super-launcher')) {
        settings.set_boolean('super-launcher', options.superLauncher);
        if (id === 'caelestia') {
            settings.set_strv('launcher-shortcut', ['<Super>space']);
            settings.set_strv('overview-shortcut', []);
        }
    }
}

// A request distinguishes deliberate layout switches from live editor updates.
export function requestLayoutTransition(settings) {
    if (settings.settings_schema?.has_key('layout-transition-request'))
        settings.set_int('layout-transition-request', (settings.get_int('layout-transition-request') + 1) % 2147483647);
}
