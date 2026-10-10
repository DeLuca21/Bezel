// Small, deterministic colour sample; independent of Shell and GTK.
const hex = rgb => '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const rgb = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
const mix = (a, b, t) => hex(rgb(a).map((v, i) => v * (1 - t) + rgb(b)[i] * t));
export function extractSwatches(pixels, width, height, stride, channels) {
    const bins = new Map();
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * stride + x * channels;
        if (channels === 4 && pixels[i + 3] < 128) continue;
        const c = Array.from(pixels.slice(i, i + 3));
        const key = c.map(v => v >> 5).join(',');
        const bin = bins.get(key) ?? {count: 0, sum: [0, 0, 0]};
        bin.count++; c.forEach((v, n) => bin.sum[n] += v); bins.set(key, bin);
    }
    const result = [];
    for (const bin of [...bins.values()].sort((a, b) => b.count - a.count)) {
        const c = bin.sum.map(v => v / bin.count);
        if (result.every(s => rgb(s).reduce((sum, v, i) => sum + (v - c[i]) ** 2, 0) > 2500)) result.push(hex(c));
        if (result.length === 6) break;
    }
    return result;
}
export function wallpaperTheme(source = '#88aacc', light = false, variant = 'muted') {
    if (!/^#[0-9a-f]{6}$/i.test(source)) source = '#88aacc';
    if (variant === 'monochrome') {
        const c = rgb(source); source = hex([0, 0, 0].map(() => c[0] * .2126 + c[1] * .7152 + c[2] * .0722));
    }
    const tint = variant === 'vibrant' ? .25 : .12;
    return {id: 'wallpaper', name: 'Wallpaper',
        bg: mix(light ? '#f5f5f5' : '#17191e', source, tint),
        surface: mix(light ? '#ffffff' : '#292c33', source, tint),
        fg: light ? '#202127' : '#f4f4f7', muted: light ? '#555761' : '#b4b6c0',
        accent: mix(source, light ? '#000000' : '#ffffff', light ? .48 : .55),
        group: mix(source, light ? '#000000' : '#ffffff', light ? .55 : .68),
        border: mix(light ? '#bfc1c8' : '#50535c', source, tint)};
}
