// Shared by the shell and preferences. Never let a hand-edited config break enable().
export const PLACES = {
    logo: 'start', workspaces: 'start', window: 'center', dashboard: 'center',
    clock: 'center', date: 'end', weather: 'end', apps: 'start', volume: 'end',
    network: 'end', battery: 'end', power: 'end', spacer: 'center',
    screenshot: 'end', dnd: 'end', performance: 'end', vpn: 'end', settings: 'end',
    nightlight: 'end', dark: 'end',
};
const OPTIONAL_MODULES = ['screenshot', 'dnd', 'performance', 'vpn', 'settings', 'nightlight', 'dark'];
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
        if ((!Object.hasOwn(PLACES, id) && !isSpacer(id)) || seen.has(id))
            return [];
        seen.add(id);
        const spacer = isSpacer(id);
        return [{
            id,
            place: ['start', 'center', 'end'].includes(item?.place) ? item.place : PLACES[id] ?? 'center',
            group: normalizeGroup(id, item),
            ...(spacer ? {size: number(item?.size, 24, 8, 400)} : {}),
        }];
    });
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
            groups.set(group.id, {id: group.id, name: String(group.name || group.id).slice(0, 60), place: group.place});
    }
    for (const item of bar.modules ?? []) {
        if (item.group && !groups.has(item.group))
            groups.set(item.group, {id: item.group, name: item.group[0].toUpperCase() + item.group.slice(1), place: item.place});
    }
    for (const group of groups.values())
        group.place = ['start', 'center', 'end'].includes(group.place) ? group.place
            : bar.modules?.find(item => item.group === group.id)?.place ?? 'center';
    return [...groups.values()];
}

export function readBars(settings) {
    const config = readConfig(settings);
    const bars = Array.isArray(config.bars) && config.bars.length ? config.bars : [{}];
    return bars.slice(0, 4).map(value => {
        const bar = value && typeof value === 'object' ? value : {};
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
            runningApps: bar.runningApps !== false,
            appSpacing: number(bar.appSpacing ?? (bar.kind === 'dock' ? 12 : 8), 10, 0, 32),
            appsLength: number(bar.appsLength ?? 0, 0, 0, 2400),
            appsCap: bar.appsCap === true,
            batteryPercentage: bar.batteryPercentage === true,
            appClick: bar.appClick === 'activate' ? 'activate' : 'minimize',
            thickness: number(bar.thickness ?? 56, 56, 44, 88),
            iconSize: number(bar.iconSize ?? 22, 22, 12, 40),
            reserveSpace: bar.reserveSpace !== false,
            reserveOffset: number(bar.reserveOffset ?? 0, 0, 0, 64),
            autohide: bar.autohide === true,
            modules: normalizeModules(bar.modules),
            pinned: [...new Set((Array.isArray(bar.pinned) ? bar.pinned : [])
                .filter(id => typeof id === 'string' && id.startsWith('app:') && id.length > 4))],
        };
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
};

export function defaultDashboard(weather = true) {
    return {
        overview: [
            {id: 'identity', size: 1}, {id: 'calendar', size: 1}, {id: 'media', size: 1},
            {id: 'actions', size: 1}, ...(weather ? [{id: 'weather', size: 1}] : []),
        ],
        media: [{id: 'media', size: 2}],
        performance: [{id: 'cpu', size: 1}, {id: 'memory', size: 1}, {id: 'temp', size: 1}],
        workspaces: [{id: 'workspaces', size: 2}],
    };
}

export function readDashboard(settings) {
    const saved = readConfig(settings).dashboard;
    const fallback = defaultDashboard(settingFlag(settings, 'weather-dashboard', true));
    if (!saved || typeof saved !== 'object')
        return fallback;
    const page = (key, items) => {
        if (!Array.isArray(items))
            return fallback[key];
        const seen = new Set();
        return items.flatMap(item => {
            const id = item?.id;
            if (!DASHBOARD_WIDGETS[id] || seen.has(id) || !DASHBOARD_WIDGETS[id].tabs.includes(key))
                return [];
            seen.add(id);
            return [{id, size: item.size === 2 ? 2 : 1}];
        });
    };
    return {
        overview: page('overview', saved.overview),
        media: page('media', saved.media),
        performance: page('performance', saved.performance),
        workspaces: page('workspaces', saved.workspaces),
    };
}

export function saveDashboard(settings, dashboard) {
    settings.set_string('config', JSON.stringify({...readConfig(settings), dashboard}));
}

export function presetBars(id, pinned = []) {
    const modules = ids => ids.map(key => ({id: key, place: PLACES[key]}));
    const base = {thickness: 56, iconSize: 22, reserveSpace: true, reserveOffset: 8, pinned};
    if (id === 'panel')
        return [{...base, edge: 'bottom', modules: modules(['logo', 'apps', 'workspaces', 'clock', 'volume', 'network', 'battery', 'power'])}];
    if (id === 'dock')
        return [{...base, edge: 'bottom', kind: 'dock', margin: 12, thickness: 64, iconSize: 36,
            modules: modules(['logo', 'apps']), rounding: 24, runningApps: true}];
    if (id === 'hybrid')
        return [
            {...base, edge: 'top', thickness: 48, pinned: [], modules: modules(['logo', 'workspaces', 'clock', 'dashboard', 'volume', 'network', 'battery', 'power'])},
            {...base, edge: 'bottom', kind: 'dock', margin: 12, thickness: 64, iconSize: 36, modules: modules(['logo', 'apps']), rounding: 24},
        ];
    return [{...base, edge: 'left', modules: modules(['logo', 'workspaces', 'apps', 'window', 'dashboard', 'clock', 'volume', 'network', 'battery', 'power'])}];
}

// Built-in layouts replace geometry; named profiles retain complete custom layouts.
export function applyPreset(settings, id, favorites = []) {
    if (!['caelestia', 'panel', 'dock', 'hybrid'].includes(id)) return;
    const config = readConfig(settings);
    const bars = readBars(settings);
    settings.set_string('previous-layout', JSON.stringify({config: settings.get_string('config'), frame: settings.get_boolean('show-frame'), indicatorBar: settings.get_int('indicator-bar')}));
    const pins = [...new Set(bars.flatMap(bar => bar.pinned))];
    const source = bars.find(bar => bar.modules.some(module => module.id === 'logo')) ?? bars[0];
    const next = presetBars(id, Array.isArray(config.bars) ? pins : favorites.map(app => `app:${app}`)).map(bar => ({...bar,
            logoIcon: source.logoIcon, logoAction: source.logoAction,
            appClick: source.appClick, runningApps: source.runningApps}));
    settings.set_string('config', JSON.stringify({...config, layoutMode: id, bars: next}));
    settings.set_boolean('show-frame', id === 'caelestia');
    settings.set_int('indicator-bar', 0);
    const shell = id === 'caelestia';
    if (!settings.settings_schema || settings.settings_schema.has_key?.('power-style')) {
        settings.set_string('power-style', shell ? 'rail' : 'list');
        settings.set_string('slider-style', shell ? 'edge' : 'drawer');
        settings.set_string('power-position', shell ? 'right' : 'icon');
        settings.set_boolean('session-dim', shell);
        settings.set_boolean('power-button-hover', !shell);
    }
    if (!settings.settings_schema || settings.settings_schema.has_key?.('indicator-icon-size')) {
        settings.set_int('indicator-icon-size', shell ? 16 : 22);
        settings.set_int('indicator-spacing', shell ? 16 : 14);
    }
    if (!settings.settings_schema || settings.settings_schema.has_key?.('super-launcher')) {
        settings.set_boolean('super-launcher', !shell);
        if (shell) {
            settings.set_strv('launcher-shortcut', ['<Super>space']);
            settings.set_strv('overview-shortcut', []);
        }
    }
}
