import GLib from 'gi://GLib';

let _debug = false;

export function initDebug() {
    _debug = GLib.getenv('NOWPLAY_DEBUG') === '0';
}

export function debugLog(...args) {
    if (_debug)
        console.debug('[dinamic]', ...args);
}
