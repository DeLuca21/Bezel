import GLib from 'gi://GLib';

import {builtInLayout, requestLayoutTransition} from './config.js';

const EXCLUDED = new Set(['wallpaper-palette', 'wallpaper-status', 'settings-layout', 'layout-transition', 'layout-transition-duration', 'layout-transition-request', 'preferences-target', 'launcher-layout-undo', 'saved-layouts', 'previous-layout', 'layout-baseline', 'shortcut-overrides', 'known-indicators', 'show-settings', 'preferences-bar', 'preferences-group', 'group-preview', 'edit-mode', 'preview-login-animation']);

const hasBaseline = settings => Boolean(settings.settings_schema?.has_key?.('layout-baseline'));

const stableValue = value => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
    return value;
};

const parsedConfig = value => {
    try {
        const config = JSON.parse(value || '{}');
        if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
        delete config.indicatorsPlaced;
        return stableValue(config);
    } catch {
        return null;
    }
};

const sameItem = (key, saved, current) => {
    if (!saved || saved.type !== current.type) return false;
    if (JSON.stringify(saved.value) === JSON.stringify(current.value)) return true;
    if (key !== 'config') return false;
    const left = parsedConfig(saved.value);
    const right = parsedConfig(current.value);
    return Boolean(left && right) && JSON.stringify(left) === JSON.stringify(right);
};

const defaultItem = (settings, key) => {
    const value = settings.settings_schema.get_key(key).get_default_value();
    return {type: value.get_type_string(), value: value.deepUnpack()};
};

const sameValues = (settings, stored, current) => Object.entries(current).every(([key, item]) => {
    const saved = stored?.[key];
    return sameItem(key, saved ?? defaultItem(settings, key), item);
});

const baselineValues = settings => {
    if (!hasBaseline(settings)) return null;
    try {
        const value = JSON.parse(settings.get_string('layout-baseline') || '');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
};

export function savedLayouts(settings) {
    try {
        const list = JSON.parse(settings.get_string('saved-layouts'));
        return Array.isArray(list) ? list.filter(item => typeof item?.name === 'string' && item.values && typeof item.values === 'object') : [];
    } catch { return []; }
}

export function nextLayoutName(settings) {
    const names = new Set(savedLayouts(settings).map(profile => profile.name));
    let n = 1;
    while (names.has(`Layout ${n}`)) n++;
    return `Layout ${n}`;
}

export function layoutValues(settings) {
    return Object.fromEntries(settings.settings_schema.list_keys().filter(key => !EXCLUDED.has(key)).sort().map(key => {
        const value = settings.get_value(key);
        return [key, {type: value.get_type_string(), value: value.deepUnpack()}];
    }));
}

export function matchingLayout(settings) {
    const current = layoutValues(settings);
    return savedLayouts(settings).find(profile => sameValues(settings, profile.values, current)) ?? null;
}

// Clean when the screen matches a named save, the last applied or loaded layout, or an untouched preset.
export function layoutIsClean(settings) {
    if (matchingLayout(settings)) return true;
    const baseline = baselineValues(settings);
    if (baseline) return sameValues(settings, baseline, layoutValues(settings));
    return Boolean(builtInLayout(settings));
}

export function captureCleanLayout(settings) {
    if (!hasBaseline(settings) || settings.get_string('layout-baseline')) return;
    if (matchingLayout(settings) || builtInLayout(settings))
        settings.set_string('layout-baseline', JSON.stringify(layoutValues(settings)));
}

export function rememberLayout(settings) {
    if (!hasBaseline(settings)) return;
    settings.set_string('layout-baseline', JSON.stringify(layoutValues(settings)));
}

export function noteRevertedLayout(settings) {
    if (!hasBaseline(settings)) return;
    if (matchingLayout(settings) || builtInLayout(settings)) rememberLayout(settings);
    else settings.set_string('layout-baseline', '');
}

export function saveLayout(settings, name) {
    name = name.trim().slice(0, 80);
    if (!name) return;
    const values = layoutValues(settings);
    const list = savedLayouts(settings).filter(item => item.name !== name);
    list.push({name, values});
    settings.set_string('saved-layouts', JSON.stringify(list));
    rememberLayout(settings);
}

export function deleteLayout(settings, name) {
    settings.set_string('saved-layouts', JSON.stringify(savedLayouts(settings).filter(item => item.name !== name)));
}

export function restoreLayout(settings, profile) {
    // Validate everything before writing anything; ignore retired schema keys.
    const values = [];
    for (const [key, item] of Object.entries(profile.values)) {
        if (EXCLUDED.has(key) || !settings.settings_schema.has_key(key)) continue;
        const schema = settings.settings_schema.get_key(key);
        if (item.type !== schema.get_value_type().dup_string()) throw new Error(`Invalid type for ${key}`);
        const variant = new GLib.Variant(item.type, item.value);
        if (!schema.range_check(variant)) throw new Error(`Invalid value for ${key}`);
        if (!settings.is_writable(key)) throw new Error(`${key} is locked`);
        values.push([key, variant]);
    }
    requestLayoutTransition(settings);
    for (const [key, variant] of values) settings.set_value(key, variant);
    rememberLayout(settings);
}
