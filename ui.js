import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import { debugLog } from './debug.js';

const CONFIG = {
    width: 520,
    height: 176,
    topMargin: 10,
    animDuration: 480,
    animCloseDuration: 340,
    autoCloseDelay: 3600,
    popupLeaveCloseDelay: 500,
};

const THEME = {
    background: 'rgba(5, 5, 7, 0.98)',
    border: 'rgba(255, 255, 255, 0.11)',
    highlight: 'rgba(255, 255, 255, 0.16)',
    progress: '#ffffff',
    accentSoft: 'rgba(52, 211, 153, 0.18)',
    text: '#ffffff',
    mutedText: '#c7c7cc',
    dimText: '#7d7d86',
    buttonBg: 'rgba(255, 255, 255, 0.075)',
    buttonBorder: 'rgba(255, 255, 255, 0.10)',
    radius: 35,
};

// Scales the art to fit `size` and cuts rounded corners directly in the
// pixel buffer (cairo isn't exposed to GJS on modern shells). St never
// clips children to border-radius, so the corners must be transparent.
function _roundArtPixbuf(pixbuf, size, radius) {
    const scale = Math.min(size / pixbuf.get_width(), size / pixbuf.get_height());
    const w = Math.max(1, Math.round(pixbuf.get_width() * scale));
    const h = Math.max(1, Math.round(pixbuf.get_height() * scale));
    const scaled = (w === pixbuf.get_width() && h === pixbuf.get_height())
        ? pixbuf
        : pixbuf.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR);

    const rgba = scaled.get_has_alpha()
        ? scaled
        : scaled.add_alpha(false, 0, 0, 0);

    const data = rgba.get_pixels(); // copy — the pixbuf is rebuilt below
    const stride = rgba.get_rowstride();
    const R = Math.min(radius, w / 2, h / 2);
    const hw = w / 2;
    const hh = h / 2;

    for (let y = 0; y < h; y++) {
        const row = y * stride;
        for (let x = 0; x < w; x++) {
            // Signed distance to the rounded rectangle, measured from the
            // pixel center; coverage = clamp(0.5 - d) gives a 1px AA edge.
            const px = x + 0.5 - hw;
            const py = y + 0.5 - hh;
            const qx = Math.abs(px) - (hw - R);
            const qy = Math.abs(py) - (hh - R);
            const ax = Math.max(qx, 0);
            const ay = Math.max(qy, 0);
            const d = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - R;
            const coverage = Math.min(1, Math.max(0, 0.5 - d));
            data[row + x * 4 + 3] = Math.round(data[row + x * 4 + 3] * coverage);
        }
    }

    // The pixbuf keeps the GBytes alive, so rebuilding from the buffer is safe.
    return GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(data),
        GdkPixbuf.Colorspace.RGB, true, 8, w, h, stride);
}

export class DinamicUi {
    constructor({ uuid, name, onOpenPopup, onControl }) {
        this._uuid = uuid;
        this._name = name;
        this._onOpenPopup = onOpenPopup;
        this._onControl = onControl;
        this._clockButton = null;
        this._clockButtonHandler = null;
        this._popup = null;
        this._popupHandler = null;
        this._closeTimer = 0;
        this._popupVisible = false;
        this._progressOuter = null;
        this._progressFill = null;
        this._currentTimeLabel = null;
        this._playPauseIcon = null;
        this._eqTimers = [];
        this._eqActive = false;
    }

    get popupVisible() {
        return this._popupVisible;
    }

    enable() {
        this._clockButton = Main.panel.statusArea.dateMenu?.actor
            || Main.panel.statusArea.dateMenu;

        if (!this._clockButton) {
            debugLog('clock button not found');
            return;
        }

        this._clockButtonHandler = this._clockButton.connectObject(
            'enter-event', () => {
                this._onOpenPopup();
                return Clutter.EVENT_PROPAGATE;
            },
            'button-press-event', (_actor, event) => {
                if (event.get_button() !== 1)
                    return Clutter.EVENT_PROPAGATE;

                this._onOpenPopup();
                return Clutter.EVENT_STOP;
            },
            'touch-event', (_actor, event) => {
                if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                    return Clutter.EVENT_PROPAGATE;

                this._onOpenPopup();
                return Clutter.EVENT_STOP;
            }
        );
    }

    disable() {
        this.destroyPopup();

        if (this._clockButton && this._clockButtonHandler) {
            this._clockButton.disconnectObject(this._clockButtonHandler);
            this._clockButtonHandler = null;
        }

        this._clockButton = null;
    }

    updateIndicator(player) {
        if (!player)
            this.destroyPopup();
    }

    togglePopup(player) {
        if (!player) return;

        if (this._popupVisible)
            this.destroyPopup();
        else
            this.showPopup(player);
    }

    showPopup(player) {
        if (!player || this._popup) return;

        this._popup = new St.BoxLayout({
            vertical: false,
            style_class: 'dinamic-popup dinamic-popup-custom',
            style: this._getPopupStyle(),
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        this.buildPopupContent(player);
        Main.layoutManager.addChrome(this._popup, { trackFullscreen: true });

        this._popupHandler = this._popup.connectObject(
            'key-press-event', (_actor, event) => {
                if (event.get_key_symbol() === Clutter.KEY_Escape) {
                    this.destroyPopup();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            },
            'enter-event', () => {
                this._clearCloseTimer();
                return Clutter.EVENT_PROPAGATE;
            },
            'leave-event', () => {
                this._scheduleClose(CONFIG.popupLeaveCloseDelay);
                return Clutter.EVENT_PROPAGATE;
            }
        );
        this._popup.grab_key_focus();

        const [x, y] = this._getPopupPosition();
        if (CONFIG.animDuration > 0) {
            this._popup.opacity = 0;
            this._popup.set_pivot_point(0.5, 0.5);
            this._popup.set_scale(0.32, 0.52);
            this._popup.set_position(x, y);

            this._popup.ease({
                opacity: 255,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            this._popup.ease({
                scale_x: 1,
                scale_y: 1,
                duration: CONFIG.animDuration,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        } else {
            this._popup.set_position(x, y);
            this._popup.opacity = 255;
        }

        this._popupVisible = true;
        this._scheduleClose(CONFIG.autoCloseDelay);
    }

    destroyPopup() {
        if (!this._popup) return;

        this._clearCloseTimer();
        this._clearEqAnimation();

        if (this._popupHandler) {
            this._popup.disconnectObject(this._popupHandler);
            this._popupHandler = null;
        }

        if (CONFIG.animCloseDuration > 0) {
            this._popup.ease({
                scale_x: 0.38,
                scale_y: 0.48,
                duration: CONFIG.animCloseDuration,
                mode: Clutter.AnimationMode.EASE_IN_BACK,
            });
            this._popup.ease({
                opacity: 0,
                duration: Math.round(CONFIG.animCloseDuration * 0.6),
                delay: Math.round(CONFIG.animCloseDuration * 0.4),
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => this._removePopup(),
            });
        } else {
            this._removePopup();
        }

        this._popupVisible = false;
    }

    _scheduleClose(delay) {
        this._clearCloseTimer();

        this._closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._closeTimer = 0;
            this.destroyPopup();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearCloseTimer() {
        if (!this._closeTimer) return;

        GLib.source_remove(this._closeTimer);
        this._closeTimer = 0;
    }

    _clearEqAnimation() {
        this._eqActive = false;
        this._eqTimers.forEach(id => GLib.source_remove(id));
        this._eqTimers = [];
    }

    buildPopupContent(player) {
        if (!this._popup || !player) return;

        for (const child of this._popup.get_children().slice())
            child.destroy();

        this._progressOuter = null;
        this._progressFill = null;
        this._currentTimeLabel = null;
        this._playPauseIcon = null;
        this._popup.style = this._getPopupStyle();

        const mainBox = new St.BoxLayout({
            vertical: false,
            style: 'padding: 16px 20px; spacing: 18px;',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._popup.add_child(mainBox);

        mainBox.add_child(this._createArtFrame(player));
        mainBox.add_child(this._createDetails(player));
    }

    updateProgress(position, player) {
        const safePosition = Math.max(0, Number.isFinite(position) ? position : 0);

        if (this._progressFill && player?.trackLen > 0) {
            const frac = Math.min(1, safePosition / player.trackLen);
            const width = this._progressOuter?.get_width?.() || 0;
            if (width > 0) {
                this._progressFill.width = Math.round(width * frac);
            }
        }

        if (this._currentTimeLabel) {
            const formatted = this._formatTime(safePosition);
            if (this._currentTimeLabel.text !== formatted)
                this._currentTimeLabel.text = formatted;
        }

        if (this._playPauseIcon && player) {
            this._playPauseIcon.icon_name = player.status === 'Playing'
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic';
        }
    }

    _removePopup() {
        if (!this._popup) return;

        this._clearEqAnimation();

        Main.layoutManager.removeChrome(this._popup);
        this._popup.destroy();
        this._popup = null;
        this._progressOuter = null;
        this._progressFill = null;
        this._currentTimeLabel = null;
        this._playPauseIcon = null;
    }

    _getPopupPosition() {
        const monitor = Main.layoutManager.primaryMonitor;
        const x = monitor.x + Math.floor((monitor.width - CONFIG.width) / 2);
        const panelHeight = Main.panel?.height || 0;
        const y = monitor.y + panelHeight + CONFIG.topMargin;

        return [x, y];
    }

    _createDetails(player) {
        const rightBox = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 7px; min-width: 80px;',
            x_expand: true,
            y_expand: true,
        });

        const headerRow = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 10px;',
            x_expand: true,
        });

        const titleLabel = new St.Label({
            text: player.title || 'Unknown',
            style: `font-weight: 700; font-size: 16px; color: ${THEME.text};`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleLabel.clutter_text.set_ellipsize(3);
        headerRow.add_child(titleLabel);
        headerRow.add_child(this._createStatusPill(player));
        rightBox.add_child(headerRow);

        const artistLabel = new St.Label({
            text: player.artist || 'Unknown Artist',
            style: `font-size: 12px; color: ${THEME.mutedText};`,
        });
        artistLabel.clutter_text.set_ellipsize(3);
        rightBox.add_child(artistLabel);

        // Passive progress bar — display only, no seek interaction
        const progOuter = new St.BoxLayout({
            style: 'background-color: rgba(255,255,255,0.13); height: 6px; border-radius: 99px; margin-top: 8px;',
            x_expand: true,
            reactive: false,
        });
        this._progressOuter = progOuter;
        this._progressFill = new St.BoxLayout({
            style: `background-color: ${THEME.progress}; border-radius: 99px;`,
            width: 0,
        });
        progOuter.add_child(this._progressFill);

        // Content is built before the popup is added to the layout, so the
        // track has no width yet and the fill can't be sized here. Apply
        // the real position once the track gets its first allocation
        // instead of waiting for the next position poll tick.
        const fill = this._progressFill;
        const sizeId = progOuter.connect('notify::width', () => {
            const width = progOuter.get_width();
            if (width <= 0) return;
            const frac = Math.min(1, (player.position || 0) / (player.trackLen || 1));
            fill.width = Math.round(width * frac);
            progOuter.disconnect(sizeId);
        });

        rightBox.add_child(progOuter);

        const trackTime = player.trackLen ? this._formatTime(player.trackLen) : '0:00';
        const timeRow = new St.BoxLayout({
            x_expand: true,
        });
        this._currentTimeLabel = new St.Label({
            text: this._formatTime(player.position),
            style: `font-size: 10px; font-weight: 600; color: ${THEME.dimText};`,
            x_align: Clutter.ActorAlign.START,
        });
        const totalTimeLabel = new St.Label({
            text: trackTime,
            style: `font-size: 10px; font-weight: 600; color: ${THEME.dimText};`,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        timeRow.add_child(this._currentTimeLabel);
        timeRow.add_child(totalTimeLabel);
        rightBox.add_child(timeRow);

        rightBox.add_child(this._createControls(player));
        this.updateProgress(player.position, player);
        return rightBox;
    }

    _createArtFrame(player) {
        const artIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style: 'width: 118px; height: 118px;',
            icon_size: 118,
        });

        // St never clips children to border-radius, so the art is
        // pre-rounded — corners cut to transparent in the pixel buffer
        // (_roundArtPixbuf) — before it's shown. Loaded via Gio async,
        // which works on every supported shell.

        const artFrame = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: 125,
            height: 125,
            style: `
                width: 125px;
                height: 125px;
                padding: 0;
                border-radius: 20px;
                background-color: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.12);
                box-shadow: 0 10px 26px rgba(0, 0, 0, 0.42);
            `,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        artFrame.add_child(artIcon);

        if (player.artUrl) {
            let file = null;
            try {
                file = Gio.File.new_for_uri(player.artUrl);
            } catch (_e) {
                // Keep the generic fallback icon if the player gives a bad art URL.
            }

            if (file) {
                // Keep the fallback hidden while loading so it doesn't
                // flash as "not found"; it only reappears on failure.
                artIcon.opacity = 0;
                file.load_contents_async(null, (f, res) => {
                    if (!artIcon.get_parent()) return; // popup closed/rebuilt

                    let pixbuf = null;
                    try {
                        const [ok, bytes] = f.load_contents_finish(res);
                        if (ok && bytes) {
                            const loader = GdkPixbuf.PixbufLoader.new();
                            loader.write(bytes);
                            loader.close();
                            pixbuf = loader.get_pixbuf();
                        }
                    } catch (_e) {}

                    if (!pixbuf) {
                        artIcon.opacity = 255;
                        return;
                    }

                    // St.Icon lost its pixbuf setter on newer shells, so the
                    // rounded art is shown as raw RGBA in an StImageContent —
                    // the same content type St.TextureCache fills.
                    const rounded = _roundArtPixbuf(pixbuf, 125, 20);
                    const content = new St.ImageContent();
                    try {
                        content.set_bytes(
                            Clutter.get_default_backend().get_cogl_context(),
                            new GLib.Bytes(rounded.get_pixels()),
                            Cogl.PixelFormat.RGBA_8888,
                            rounded.get_width(),
                            rounded.get_height(),
                            rounded.get_rowstride());
                    } catch (_e) {
                        artIcon.opacity = 255;
                        return;
                    }

                    const artImage = new Clutter.Actor({
                        content,
                        width: 125,
                        height: 125,
                    });
                    artImage.set_position(0, 0);
                    artFrame.add_child(artImage);
                    // The fallback stays hidden behind the art — it would
                    // show through the transparent rounded corners.
                });
            }
        }

        // Wrap art + badge using FixedLayout so set_position() is respected
        const wrapper = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: 125,
            height: 125,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        artFrame.set_position(0, 0);
        wrapper.add_child(artFrame);

        const appIcon = player.appIconName;
        if (appIcon) {
            const badgeIcon = new St.Icon({
                // default fallbacks render a generic app icon instead of
                // leaving the badge blank when the name isn't in the theme
                gicon: Gio.ThemedIcon.new_with_default_fallbacks(appIcon),
                icon_size: 30,
                style: 'width: 30px; height: 30px;',
            });
            const badge = new St.Bin({
                child: badgeIcon,
                style: `
                    width: 32px;
                    height: 32px;
                    border-radius: 8px;
                    background-color: rgba(10, 10, 12, 0.88);
                    border: 1px solid rgba(255, 255, 255, 0.18);
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.55);
                `,
            });
            // 118 - 28 (badge) - 4 (margin) = 86, bottom-right
            badge.set_position(92, 92);
            wrapper.add_child(badge);
        }

        return wrapper;
    }

    _createStatusPill(player) {
        const isPlaying = player.status === 'Playing';

        // Equalizer bars
        const barBox = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 2px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const NUM_BARS = 4;
        const bars = [];
        const barBaseHeights = [4, 0, 6, 2];
        const barHeights = [1.8, 1.3, 2.2, 1.5];
        const barSpeeds = [420, 360, 500, 440];

        for (let i = 0; i < NUM_BARS; i++) {
            const bar = new St.Widget({
                style: `
                    width: 3px;
                    min-height: 6px;
                    height: ${barBaseHeights[i]}px;
                    background-color: ${THEME.text};
                    border-radius: 2px;
                `,
            });
            bar.set_pivot_point(0.5, 1.0);
            bars.push(bar);
            barBox.add_child(bar);
        }

        // Equalizer true up-down loop when playing
        if (isPlaying) {
            this._eqActive = true;
            bars.forEach((bar, i) => {
                const animateUp = () => {
                    if (!this._eqActive || !bar.get_parent()) return;
                    bar.ease({
                        scale_y: barHeights[i],
                        duration: barSpeeds[i],
                        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                        onComplete: () => animateDown(),
                    });
                };
                const animateDown = () => {
                    if (!this._eqActive || !bar.get_parent()) return;
                    bar.ease({
                        scale_y: 1.0,
                        duration: barSpeeds[i],
                        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                        onComplete: () => animateUp(),
                    });
                };

                // Stagger bar starts so they move at different phases
                const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, i * 110, () => {
                    animateUp();
                    return GLib.SOURCE_REMOVE;
                });
                this._eqTimers.push(id);
            });
        }

        return barBox;
    }

    _createControls(player) {
        const controls = new St.BoxLayout({
            style: 'spacing: 6px; padding-top: 6px;',
            x_align: Clutter.ActorAlign.CENTER,
        });

        controls.add_child(this._makeButton('media-skip-backward-symbolic', () => this._onControl('Previous')));

        this._playPauseIcon = new St.Icon({
            icon_name: player.status === 'Playing'
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic',
            style: 'width: 40px; height: 40px;',
            icon_size: 40,
        });
        const playPauseButton = new St.Button({
            style_class: 'dinamic-control-button dinamic-primary-button',
            style: this._getButtonStyle(true),
            child: this._playPauseIcon,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        playPauseButton.set_pivot_point(0.5, 0.5);
        playPauseButton.connect('button-press-event', () => {
            playPauseButton.ease({ scale_x: 0.78, scale_y: 0.78, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            return Clutter.EVENT_PROPAGATE;
        });
        playPauseButton.connect('button-release-event', () => {
            playPauseButton.ease({ scale_x: 1.10, scale_y: 1.10, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            playPauseButton.ease({ scale_x: 1, scale_y: 1, duration: 220, delay: 100, mode: Clutter.AnimationMode.EASE_OUT_BACK });
            return Clutter.EVENT_PROPAGATE;
        });
        playPauseButton.connect('clicked', () => this._onControl('PlayPause'));
        controls.add_child(playPauseButton);

        controls.add_child(this._makeButton('media-skip-forward-symbolic', () => this._onControl('Next')));
        return controls;
    }

    _makeButton(iconName, callback) {
        const icon = new St.Icon({
            icon_name: iconName,
            style: 'width: 40px; height: 40px;',
            icon_size: 40,
        });
        const button = new St.Button({
            style_class: 'dinamic-control-button dinamic-secondary-button',
            style: this._getButtonStyle(false),
            child: icon,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        button.set_pivot_point(0.5, 0.5);
        button.connect('button-press-event', () => {
            button.ease({ scale_x: 0.80, scale_y: 0.80, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('button-release-event', () => {
            button.ease({ scale_x: 1.10, scale_y: 1.10, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            button.ease({ scale_x: 1, scale_y: 1, duration: 220, delay: 100, mode: Clutter.AnimationMode.EASE_OUT_BACK });
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('clicked', callback);
        return button;
    }

    _getPopupStyle() {
        return `
            background-color: ${THEME.background};
            border: 1px solid ${THEME.border};
            border-radius: ${THEME.radius}px;
            box-shadow: 0 22px 56px rgba(0, 0, 0, 0.66);
            width: ${CONFIG.width}px;
            height: ${CONFIG.height}px;
        `;
    }

    _getButtonStyle(primary) {
        const color = THEME.text;
        const size = primary ? 28 : 22;

        return `
            padding: 0;
            color: ${color};
            background-color: transparent;
            border: none;
            min-width: ${size}px;
            min-height: ${size}px;
        `;
    }

    _formatTime(usec) {
        if (!usec || usec <= 0) return '0:00';

        const sec = Math.floor(usec / 1_000_000);
        return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, '0')}`;
    }
}
