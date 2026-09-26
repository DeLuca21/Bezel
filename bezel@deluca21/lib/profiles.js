import GLib from 'gi://GLib';

const EXCLUDED = new Set(['saved-layouts', 'previous-layout', 'shortcut-overrides', 'known-indicators', 'show-settings', 'preferences-bar', 'edit-mode']);
export function savedLayouts(settings) {
    try {
        const list = JSON.parse(settings.get_string('saved-layouts'));
        return Array.isArray(list) ? list.filter(item => typeof item?.name === 'string' && item.values && typeof item.values === 'object') : [];
    } catch { return []; }
}

export function layoutValues(settings) {
    return Object.fromEntries(settings.settings_schema.list_keys().filter(key => !EXCLUDED.has(key)).sort().map(key => {
        const value = settings.get_value(key);
        return [key, {type: value.get_type_string(), value: value.deepUnpack()}];
    }));
}

export function matchingLayout(settings) {
    const current = layoutValues(settings);
    return savedLayouts(settings).find(profile => Object.entries(current).every(([key, item]) =>
        JSON.stringify(profile.values[key]) === JSON.stringify(item))) ?? null;
}

export function saveLayout(settings, name) {
    name = name.trim().slice(0, 80);
    if (!name) return;
    const values = layoutValues(settings);
    const list = savedLayouts(settings).filter(item => item.name !== name);
    list.push({name, values});
    settings.set_string('saved-layouts', JSON.stringify(list));
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
    for (const [key, variant] of values) settings.set_value(key, variant);
}
