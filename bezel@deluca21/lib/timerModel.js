export function parseDuration(value) {
    const parts = String(value).trim().split(':');
    if (!parts.length || parts.length > 3 || parts.some(part => !/^\d+$/.test(part))) return null;
    const values = parts.map(Number);
    if (values.slice(1).some(value => value >= 60)) return null;
    const seconds = values.length === 1 ? values[0] * 60 : values.reduce((total, value) => total * 60 + value, 0);
    return seconds > 0 && seconds <= 86400 ? seconds : null;
}
export function durationText(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
