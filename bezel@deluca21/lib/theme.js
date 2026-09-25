export const PRESETS = [
    {
        id: 'catppuccin-latte',
        name: 'Catppuccin Latte',
        bg: '#eff1f5',
        surface: '#ccd0da',
        fg: '#4c4f69',
        muted: '#6c6f85',
        accent: '#8839ef',
        border: '#bcc0cc',
    },
    {
        id: 'catppuccin-frappe',
        name: 'Catppuccin Frappé',
        bg: '#303446',
        surface: '#414559',
        fg: '#c6d0f5',
        muted: '#a5adce',
        accent: '#ca9ee6',
        border: '#51576d',
    },
    {
        id: 'catppuccin-macchiato',
        name: 'Catppuccin Macchiato',
        bg: '#24273a',
        surface: '#363a4f',
        fg: '#cad3f5',
        muted: '#a5adcb',
        accent: '#c6a0f6',
        border: '#494d64',
    },
    {
        id: 'catppuccin-mocha',
        name: 'Catppuccin Mocha',
        bg: '#1e1e2e',
        surface: '#313244',
        fg: '#cdd6f4',
        muted: '#a6adc8',
        accent: '#cba6f7',
        border: '#45475a',
    },
    {
        id: 'nord',
        name: 'Nord',
        bg: '#2e3440',
        surface: '#3b4252',
        fg: '#eceff4',
        muted: '#d8dee9',
        accent: '#88c0d0',
        border: '#4c566a',
    },
    {
        id: 'rose-pine',
        name: 'Rosé Pine',
        bg: '#191724',
        surface: '#1f1d2e',
        fg: '#e0def4',
        muted: '#908caa',
        accent: '#c4a7e7',
        border: '#403d52',
    },
    {
        id: 'rose-pine-moon',
        name: 'Rosé Pine Moon',
        bg: '#232136',
        surface: '#2a273f',
        fg: '#e0def4',
        muted: '#908caa',
        accent: '#c4a7e7',
        border: '#44415a',
    },
    {
        id: 'rose-pine-dawn',
        name: 'Rosé Pine Dawn',
        bg: '#faf4ed',
        surface: '#fffaf3',
        fg: '#575279',
        muted: '#797593',
        accent: '#907aa9',
        border: '#dfdad9',
    },
    // Original Bezel palettes, paired light/dark options where useful.
    {id: 'bezel-forest', name: 'Bezel Forest', bg: '#202b26', surface: '#2d3c33', fg: '#e3ebdb', muted: '#abbba6', accent: '#abd496', border: '#4c6253'},
    {id: 'bezel-sage', name: 'Bezel Sage', bg: '#edf1e7', surface: '#f8faf3', fg: '#344b3d', muted: '#62745f', accent: '#527f59', border: '#c8d5c2'},
    {id: 'bezel-ocean', name: 'Bezel Ocean', bg: '#152535', surface: '#22384d', fg: '#e0eff7', muted: '#9db5c7', accent: '#70cde0', border: '#3d5970'},
    {id: 'bezel-sand', name: 'Bezel Sand', bg: '#f4ebdc', surface: '#fff8ed', fg: '#594731', muted: '#7a6855', accent: '#976333', border: '#d8c9b2'},
    {id: 'bezel-ember', name: 'Bezel Ember', bg: '#2d2223', surface: '#413032', fg: '#f4e3d7', muted: '#c7a99e', accent: '#efa07f', border: '#66494b'},
    {id: 'bezel-monochrome', name: 'Bezel Monochrome', bg: '#1c1d20', surface: '#2c2e33', fg: '#f0f1f3', muted: '#aeb0b7', accent: '#d0d3dc', border: '#484b53'},

];

const PRESET_BY_ID = Object.fromEntries(PRESETS.map(theme => [theme.id, theme]));

export function resolveTheme(settings) {
    const id = settings.get_string('theme');
    if (id === 'custom') {
        return {
            id,
            name: 'Custom',
            ...Object.fromEntries(['bg', 'surface', 'fg', 'muted', 'accent', 'border'].map(key => {
                const value = settings.get_string(`custom-${key}`);
                const hex = /^#[0-9a-f]{6}$/i.test(value) ? value
                    : /^#[0-9a-f]{3}$/i.test(value) ? `#${value.slice(1).split('').map(c => c + c).join('')}`
                    : PRESET_BY_ID['catppuccin-mocha'][key];
                return [key, hex];
            })),
        };
    }
    return PRESET_BY_ID[id] ?? PRESET_BY_ID['catppuccin-mocha'];
}

export function hexToRgba(hex, alpha = 1) {
    const value = hex.replace('#', '');
    const expanded = value.length === 3
        ? value.split('').map(channel => channel + channel).join('')
        : value;
    const r = parseInt(expanded.slice(0, 2), 16);
    const g = parseInt(expanded.slice(2, 4), 16);
    const b = parseInt(expanded.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
