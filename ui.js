import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Cairo from 'cairo';

import { debugLog } from './debug.js';

// Optional rounded backdrop blur, also used by Blur my Shell. Keep the
// translucent surface when the library is unavailable on another machine.
let RoundedBlur = null;
try {
    const { default: Blur } = await import('gi://Blur');
    if (Blur.BlurEffect.list_properties().some(p => p.name === 'corner-radius'))
        RoundedBlur = Blur;
} catch (_e) {
    // The rounded-blur library is not a required extension dependency.
}

const CONFIG = {
    width: 520,
    height: 176,
    topMargin: 10,
    animDuration: 560,
    animCloseDuration: 300,
    animSpringDuration: 600,
    artFlipDuration: 250,
    autoCloseDelay: 3600,
    popupLeaveCloseDelay: 500,
};

const THEME = {
    border: 'rgba(255, 255, 255, 0.20)',
    highlight: 'rgba(255, 255, 255, 0.16)',
    accent: '#34d399',
    accentSoft: 'rgba(52, 211, 153, 0.18)',
    text: '#ffffff',
    mutedText: '#e0e3ed',
    dimText: '#b6bdcc',
    buttonBg: 'rgba(255, 255, 255, 0.075)',
    buttonBorder: 'rgba(255, 255, 255, 0.10)',
    radius: 48,
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

// Sample a small thumbnail and select its strongest color group. Favor
// colorful pixels so shadows and white lettering do not wash out the glow.
function _getArtworkGlow(pixbuf) {
    const sample = pixbuf.scale_simple(24, 24, GdkPixbuf.InterpType.BILINEAR);
    const pixels = sample.get_pixels();
    const stride = sample.get_rowstride();
    const channels = sample.get_n_channels();
    const groups = new Map();

    for (let y = 0; y < 24; y++) {
        for (let x = 0; x < 24; x++) {
            const offset = y * stride + x * channels;
            const [r, g, b] = pixels.slice(offset, offset + 3);
            const alpha = channels === 4 ? pixels[offset + 3] / 255 : 1;
            const peak = Math.max(r, g, b);
            if (!alpha || peak < 24) continue;

            const weight = alpha * (0.2 + (peak - Math.min(r, g, b)) / peak);
            const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
            const group = groups.get(key) || { weight: 0, r: 0, g: 0, b: 0 };
            group.weight += weight;
            group.r += r * weight;
            group.g += g * weight;
            group.b += b * weight;
            groups.set(key, group);
        }
    }

    const dominant = [...groups.values()].sort((a, b) => b.weight - a.weight)[0];
    if (!dominant) return null;

    const rgb = [dominant.r, dominant.g, dominant.b].map(c => c / dominant.weight);
    const gain = Math.max(1, Math.min(2.4, 200 / Math.max(...rgb)));
    return rgb.map(c => Math.round(Math.min(255, c * gain))).join(', ');
}

// Player display name for the selector: the resolved icon name (usually the
// app name, e.g. 'spotify'), else the bus name with the MPRIS prefix stripped.
function _prettyPlayerName(player) {
    const raw = player.appIconName
        || (player.busName || '').replace(/^org\.mpris\.MediaPlayer2\./, '');
    if (!raw) return 'Unknown Player';
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export class DinamicUi {
    constructor({ uuid, name, onOpenPopup, onControl, onSeek, onSelectPlayer }) {
        this._uuid = uuid;
        this._name = name;
        this._onOpenPopup = onOpenPopup;
        this._onControl = onControl;
        this._onSeek = onSeek;
        this._onSelectPlayer = onSelectPlayer;
        this._clockButton = null;
        this._clockButtonHandler = null;
        this._stagePointerHandler = null;
        this._popup = null;
        this._popupHandler = null;
        this._closeTimer = 0;
        this._popupVisible = false;
        this._popupPressed = false;
        this._popupDragStart = null;
        this._clickWave = null;
        this._clickWaveLayer = null;
        this._artFrame = null;
        this._artFlip = null;
        this._artTrack = null;
        this._artContent = null;
        this._artReady = false;
        this._artFlipDirection = 1;
        this._progressOuter = null;
        this._progressPlayer = null;
        this._seekDrag = null;
        this._progressFill = null;
        this._progressThumb = null;
        this._currentTimeLabel = null;
        this._playPauseIcon = null;
        this._eqTimers = [];
        this._eqActive = false;
        this._menuEqTimers = [];
        this._playerPill = null;
        this._playerPillContent = null;
        this._playerMenu = null;
        this._playerMenuOpen = false;
        this._playerGrab = null;
        this._playerSelected = false;
    }

    get popupVisible() {
        return this._popupVisible;
    }

    enable() {
        this._clockButton = Main.panel.statusArea.dateMenu;

        if (!this._clockButton) {
            debugLog('clock button not found');
            return;
        }

        this._clockButtonHandler = this._clockButton;
        this._clockButton.connectObject(
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
            this._clockButtonHandler,
        );

        // Pointer events can be consumed by date-menu children before they
        // reach the button. Listen at the stage so both mouse hover and
        // finger-down open the popup immediately.
        this._stagePointerHandler = global.stage.connect('captured-event',
            (_actor, event) => {
                const isTouch = event.type() === Clutter.EventType.TOUCH_BEGIN;
                const isMotion = event.type() === Clutter.EventType.MOTION;
                if (!isTouch && !isMotion)
                    return Clutter.EVENT_PROPAGATE;

                const [x, y] = event.get_coords();
                const [buttonX, buttonY] = this._clockButton.get_transformed_position();
                const insideClock = x >= buttonX
                    && x <= buttonX + this._clockButton.get_width()
                    && y >= buttonY
                    && y <= buttonY + this._clockButton.get_height();

                if (!insideClock)
                    return Clutter.EVENT_PROPAGATE;

                this._onOpenPopup();
                return isTouch ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
            });
    }

    disable() {
        this.destroyPopup();

        if (this._clockButton && this._clockButtonHandler) {
            this._clockButton.disconnectObject(this._clockButtonHandler);
            this._clockButtonHandler = null;
        }

        if (this._stagePointerHandler) {
            global.stage.disconnect(this._stagePointerHandler);
            this._stagePointerHandler = null;
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

    showPopup(player, players) {
        if (!player || this._popupVisible) return;
        if (this._popup)
            this._removePopup();

        this._popup = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'dinamic-popup dinamic-popup-custom',
            style: this._getPopupStyle(),
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        Main.layoutManager.addChrome(this._popup, { trackFullscreen: true });
        this.buildPopupContent(player, players);

        this._popupHandler = this._popup;
        this._popup.connectObject(
            'captured-event', (_actor, event) => {
                const type = event.type();
                if ((type === Clutter.EventType.BUTTON_PRESS && event.get_button() === 1)
                    || type === Clutter.EventType.TOUCH_BEGIN) {
                    const [x, y] = event.get_coords();
                    const [barX, barY] = this._progressOuter.get_transformed_position();
                    const [barWidth, barHeight] = this._progressOuter.get_transformed_size();
                    if (this._progressOuter.reactive && x >= barX && x <= barX + barWidth
                        && y >= barY && y <= barY + barHeight) {
                        this._seekDrag = { player: { ...this._progressPlayer }, position: 0 };
                        this._clearCloseTimer();
                        this._updateSeek(event);
                        this._startClickWave(event);
                        return Clutter.EVENT_STOP;
                    }
                    this._animatePopupPress(true, event);
                    this._startClickWave(event);
                } else if ((type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === 1)
                    || type === Clutter.EventType.TOUCH_END
                    || type === Clutter.EventType.TOUCH_CANCEL) {
                    if (this._seekDrag) {
                        if (type !== Clutter.EventType.TOUCH_CANCEL)
                            this._updateSeek(event);
                        this._finishSeek(type !== Clutter.EventType.TOUCH_CANCEL);
                        return Clutter.EVENT_STOP;
                    }
                    this._animatePopupPress(false);
                } else if (type === Clutter.EventType.MOTION
                    || type === Clutter.EventType.TOUCH_UPDATE) {
                    if (this._seekDrag) {
                        this._updateSeek(event);
                        return Clutter.EVENT_STOP;
                    }
                    this._animatePopupDrag(event);
                }
                return Clutter.EVENT_PROPAGATE;
            },
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
                if (!this._popupPressed && !this._seekDrag && !this._playerMenuOpen && !this._pointerInsidePlayerPill())
                    this._scheduleClose(CONFIG.popupLeaveCloseDelay);
                return Clutter.EVENT_PROPAGATE;
            },
            this._popupHandler,
        );
        this._popup.grab_key_focus();

        const [x, y] = this._getPopupPosition();
        if (CONFIG.animDuration > 0) {
            this._popup.opacity = 0;
            this._popup.set_pivot_point(0.5, 0.5);
            this._popup.set_scale(0.18, 0.16);
            this._popup.translation_y = -CONFIG.height * (1 - 0.16) / 2 - 4;
            this._popup.set_position(x, y);

            const content = this._popup.get_last_child();
            content.opacity = 0;
            content.ease({
                opacity: 255,
                duration: 180,
                delay: 90,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            this._popup.ease({
                opacity: 255,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            this._popup.ease({
                scale_x: 1,
                scale_y: 1,
                translation_y: 0,
                duration: CONFIG.animDuration,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        } else {
            this._popup.set_position(x, y);
            this._popup.opacity = 255;
        }

        // The selector pill (if any) centers under the popup once the
        // popup has its final position.
        this._placePlayerPill();

        this._popupVisible = true;
        this._scheduleClose(CONFIG.autoCloseDelay);
    }

    _animatePopupPress(pressed, event = null) {
        if (!this._popup || !this._popupVisible || this._popupPressed === pressed)
            return;

        this._popupPressed = pressed;
        let offsetX = 0;
        let offsetY = 0;
        if (pressed) {
            this._clearCloseTimer();
            const [x, y] = event.get_coords();
            const [px, py] = this._popup.get_transformed_position();
            const [width, height] = this._popup.get_transformed_size();
            offsetX = Math.max(-0.5, Math.min(0.5, (x - px) / Math.max(1, width) - 0.5)) * 5;
            offsetY = Math.max(-0.5, Math.min(0.5, (y - py) / Math.max(1, height) - 0.5)) * 4;
            this._popupDragStart = { x, y, offsetX, offsetY };
        } else {
            this._popupDragStart = null;
            if (!this._pointerInsidePopup() && !this._playerMenuOpen)
                this._scheduleClose(CONFIG.animSpringDuration + CONFIG.popupLeaveCloseDelay);
        }

        this._popup.ease({
            scale_x: pressed ? 0.985 : 1,
            scale_y: pressed ? 0.97 : 1,
            translation_x: offsetX,
            translation_y: offsetY,
            duration: pressed ? 110 : CONFIG.animSpringDuration,
            mode: pressed ? Clutter.AnimationMode.EASE_OUT_QUAD : Clutter.AnimationMode.EASE_OUT_ELASTIC,
        });
    }

    _startClickWave(event) {
        if (!this._popupVisible || !this._clickWaveLayer || !St.Settings.get().enable_animations)
            return;

        this._clickWave?.timeline.stop();
        const [x, y] = event.get_coords();
        const [px, py] = this._popup.get_transformed_position();
        const [width, height] = this._popup.get_transformed_size();
        const timeline = new Clutter.Timeline({ actor: this._popup, duration: 560 });
        const wave = {
            x: (x - px) / Math.max(1, width) * this._popup.width,
            y: (y - py) / Math.max(1, height) * this._popup.height,
            progress: 0,
            timeline,
        };
        this._clickWave = wave;
        timeline.connect('new-frame', () => {
            wave.progress = timeline.get_progress();
            this._clickWaveLayer?.queue_repaint();
        });
        timeline.connect('completed', () => {
            if (this._clickWave !== wave) return;
            this._clickWave = null;
            this._clickWaveLayer?.queue_repaint();
        });
        timeline.start();
    }

    _drawClickWave(area) {
        const cr = area.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const wave = this._clickWave;
        if (wave) {
            const [width, height] = area.get_surface_size();
            const radius = Math.min(THEME.radius * St.ThemeContext.get_for_stage(global.stage).scale_factor,
                width / 2, height / 2);
            cr.arc(width - radius, radius, radius, -Math.PI / 2, 0);
            cr.arc(width - radius, height - radius, radius, 0, Math.PI / 2);
            cr.arc(radius, height - radius, radius, Math.PI / 2, Math.PI);
            cr.arc(radius, radius, radius, Math.PI, Math.PI * 1.5);
            cr.closePath();
            cr.clip();

            const extent = Math.hypot(Math.max(wave.x, width - wave.x), Math.max(wave.y, height - wave.y));
            const spread = 8 + extent * (1 - (1 - wave.progress) ** 2);
            const fade = (1 - wave.progress) ** 2;
            const gradient = new Cairo.RadialGradient(wave.x, wave.y, 0, wave.x, wave.y, spread);
            gradient.addColorStopRGBA(0, 1, 1, 1, 0.06 * fade);
            gradient.addColorStopRGBA(0.55, 1, 1, 1, 0.02 * fade);
            gradient.addColorStopRGBA(0.82, 1, 1, 1, 0.18 * fade);
            gradient.addColorStopRGBA(1, 1, 1, 1, 0);
            cr.setSource(gradient);
            cr.paint();
        }
        cr.$dispose();
    }

    _animatePopupDrag(event) {
        if (!this._popupVisible || !this._popupPressed || !this._popupDragStart)
            return;

        const [x, y] = event.get_coords();
        const start = this._popupDragStart;
        const pullX = Math.tanh((x - start.x) / 90);
        const pullY = Math.tanh((y - start.y) / 80);
        if (!start.dragging) {
            // Take over the visible pose, including an unfinished press or
            // spring return, rather than snapping to the pressed pose.
            start.offsetX = this._popup.translation_x;
            start.offsetY = this._popup.translation_y;
            start.scaleX = this._popup.scale_x;
            start.scaleY = this._popup.scale_y;
            for (const property of ['translation-x', 'translation-y', 'scale-x', 'scale-y'])
                this._popup.remove_transition(property);
            start.dragging = true;
        }

        // Follow input directly; restarting an ease on every motion makes
        // the card lag behind the pointer. Animate only the release.
        this._popup.set({
            translation_x: Math.max(-22, Math.min(22, start.offsetX + pullX * 18)),
            translation_y: Math.max(-18, Math.min(18, start.offsetY + pullY * 14)),
            scale_x: Math.max(0.96, Math.min(1.025, start.scaleX + Math.abs(pullX) * 0.025 - Math.abs(pullY) * 0.010)),
            scale_y: Math.max(0.94, Math.min(1.015, start.scaleY + Math.abs(pullY) * 0.035 - Math.abs(pullX) * 0.008)),
        });
    }

    destroyPopup() {
        if (!this._popup) return;

        this._seekDrag = null;
        this._popupPressed = false;
        this._popupDragStart = null;
        this._clickWave?.timeline.stop();
        this._clickWave = null;
        this._clickWaveLayer?.queue_repaint();
        this._destroyPlayerMenu();
        this._destroyPlayerPill(true);
        this._clearCloseTimer();
        this._clearEqAnimation();

        if (this._popupHandler) {
            this._popup.disconnectObject(this._popupHandler);
            this._popupHandler = null;
        }

        if (CONFIG.animCloseDuration > 0) {
            this._popup.get_last_child().ease({
                opacity: 0,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
            });
            this._popup.ease({
                scale_x: 0.18,
                scale_y: 0.16,
                translation_x: 0,
                translation_y: -CONFIG.height * (1 - 0.16) / 2 - 4,
                duration: CONFIG.animCloseDuration,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            });
            this._popup.ease({
                opacity: 0,
                duration: Math.round(CONFIG.animCloseDuration * 0.3),
                delay: Math.round(CONFIG.animCloseDuration * 0.7),
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

    buildPopupContent(player, players) {
        if (!this._popup || !player) {
            this._playerSelected = false;
            return;
        }

        if (this._seekDrag) {
            const target = this._seekDrag.player;
            if (player.busName === target.busName && player.trackId === target.trackId && player.canSeek)
                return;
            this._finishSeek(false);
        }

        const track = {
            busName: player.busName,
            key: player.trackId || `${player.title}\n${player.artist}`,
        };
        if (this._artTrack?.busName === track.busName && this._artTrack.key !== track.key) {
            this._artFlip = {
                content: this._artFlip && this._artFlip.phase !== 'in'
                    ? this._artFlip.content : this._artContent,
                direction: this._artFlipDirection,
                phase: 'out',
                startedAt: GLib.get_monotonic_time(),
                actor: null,
                overlay: null,
            };
            this._artFlipDirection = 1;
        } else if (this._artTrack?.busName !== track.busName) {
            this._artFlip = null;
            this._artFlipDirection = 1;
        }
        this._artTrack = track;

        this._destroyPlayerMenu();
        this._destroyPlayerPill();
        this._clearEqAnimation();

        for (const child of this._popup.get_children().slice())
            child.destroy();

        this._progressOuter = null;
        this._progressFill = null;
        this._progressThumb = null;
        this._currentTimeLabel = null;
        this._playPauseIcon = null;
        this._popup.style = this._getPopupStyle();
        const glass = this._addGlassBackground(this._popup, THEME.radius);
        this._clickWaveLayer = new St.DrawingArea({ x_expand: true, y_expand: true });
        this._clickWaveLayer.connect('repaint', area => this._drawClickWave(area));
        this._popup.add_child(this._clickWaveLayer);

        const mainBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'padding: 20px; spacing: 20px;',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._popup.add_child(mainBox);

        mainBox.add_child(this._createArtFrame(player, glass));
        mainBox.add_child(this._createDetails(player));
        this._animateArtworkFlip();
        this.updateProgress(player.position, player);

        if (players.length > 1)
            this._createPlayerPill(players, player);

        // Pop only when the dropdown selection caused this rebuild — control
        // buttons (play/pause can switch the active player in auto mode) must
        // not bounce the card.
        if (this._playerSelected) {
            this._playerSelected = false;
            this._popPlayerCard();
        }
    }

    // Quick "pop" on the card when the controlled player switches: a small
    // scale bounce with overshoot, same feel as the entrance animation.
    _popPlayerCard() {
        if (!this._popup) return;

        this._popup.set_pivot_point(0.5, 0.5);
        this._popup.set_scale(0.9, 0.9);
        this._popup.ease({
            scale_x: 1,
            scale_y: 1,
            duration: CONFIG.animCloseDuration,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    updateProgress(position, player) {
        if (this._seekDrag)
            position = this._seekDrag.position;
        const safePosition = Math.max(0, Number.isFinite(position) ? position : 0);

        if (this._progressFill && player.trackLen > 0) {
            const frac = Math.min(1, safePosition / player.trackLen);
            const width = this._progressOuter.get_width() || 0;
            if (width > 0) {
                this._progressFill.set_style(`width: ${Math.round(width * frac)}px;`);
                this._progressFill.visible = frac > 0;
                const thumbWidth = this._progressThumb.get_width() || 10;
                this._progressThumb.translation_x = Math.max(0, Math.min(
                    width - thumbWidth, width * frac - thumbWidth / 2));
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

    _updateSeek(event) {
        const [x] = event.get_coords();
        const [left] = this._progressOuter.get_transformed_position();
        const [width] = this._progressOuter.get_transformed_size();
        const { player } = this._seekDrag;
        const fraction = Math.max(0, Math.min(1, (x - left) / Math.max(1, width)));
        this._seekDrag.position = Math.min(player.trackLen - 1, Math.round(fraction * player.trackLen));
        this.updateProgress(this._seekDrag.position, player);
    }

    async _finishSeek(commit) {
        const seek = this._seekDrag;
        this._seekDrag = null;
        if (!this._pointerInsidePopup() && !this._playerMenuOpen)
            this._scheduleClose(CONFIG.popupLeaveCloseDelay);

        const success = commit && await this._onSeek?.(seek.position, seek.player);
        const player = this._progressPlayer;
        if (this._popupVisible && player?.busName === seek.player.busName
            && player.trackId === seek.player.trackId)
            this.updateProgress(success ? seek.position : player.position, player);
    }

    _removePopup() {
        if (!this._popup) return;

        this._clearEqAnimation();

        Main.layoutManager.removeChrome(this._popup);
        this._artFrame = null;
        this._artFlip = null;
        this._artTrack = null;
        this._artContent = null;
        this._artReady = false;
        this._artFlipDirection = 1;
        this._clickWaveLayer = null;
        this._popup.destroy();
        this._popup = null;
        this._progressOuter = null;
        this._progressPlayer = null;
        this._progressFill = null;
        this._progressThumb = null;
        this._currentTimeLabel = null;
        this._playPauseIcon = null;
    }

    _getPopupPosition() {
        const monitor = Main.layoutManager.primaryMonitor;
        const x = monitor.x + Math.floor((monitor.width - CONFIG.width) / 2);
        const panelHeight = Main.panel.height;
        const y = monitor.y + panelHeight + CONFIG.topMargin;

        return [x, y];
    }

    _createDetails(player) {
        const rightBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 3px; min-width: 80px;',
            x_expand: true,
            y_expand: true,
        });

        const headerRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 10px;',
            x_expand: true,
        });

        const titleLabel = new St.Label({
            text: player.title || 'Unknown',
            style: `font-weight: 600; font-size: 18px; color: ${THEME.text}; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleLabel.clutter_text.set_ellipsize(3);
        headerRow.add_child(titleLabel);
        headerRow.add_child(this._createStatusPill(player));
        rightBox.add_child(headerRow);

        const artistLabel = new St.Label({
            text: player.artist || 'Unknown Artist',
            style: 'font-size: 14px; color: #c6d7ed;',
        });
        artistLabel.clutter_text.set_ellipsize(3);
        rightBox.add_child(artistLabel);

        this._progressPlayer = player;
        const progOuter = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            style: 'height: 12px; margin-top: 6px;',
            x_expand: true,
            reactive: Boolean(player.canSeek && player.trackId && player.trackLen > 0),
        });
        this._progressOuter = progOuter;
        const track = new St.Widget({
            style_class: 'dinamic-progress-track',
            y: 4,
        });
        track.add_constraint(new Clutter.BindConstraint({
            source: progOuter,
            coordinate: Clutter.BindCoordinate.WIDTH,
        }));
        progOuter.add_child(track);
        this._progressFill = new St.Widget({
            style_class: 'dinamic-progress-fill',
            style: 'width: 0px;',
            y: 4,
        });
        progOuter.add_child(this._progressFill);
        this._progressThumb = new St.Widget({
            style_class: 'dinamic-progress-thumb',
            y: 1,
        });
        progOuter.add_child(this._progressThumb);

        // Apply the initial position once the track has an allocated width.
        const sizeId = progOuter.connect('notify::width', () => {
            const width = progOuter.get_width();
            if (width <= 0) return;
            this.updateProgress(player.position, player);
            progOuter.disconnect(sizeId);
        });

        rightBox.add_child(progOuter);

        const trackTime = player.trackLen ? this._formatTime(player.trackLen) : '0:00';
        const timeRow = new St.BoxLayout({
            x_expand: true,
        });
        this._currentTimeLabel = new St.Label({
            text: this._formatTime(player.position),
            style: 'font-size: 11px; color: #d0e0f5;',
            x_align: Clutter.ActorAlign.START,
        });
        const totalTimeLabel = new St.Label({
            text: trackTime,
            style: 'font-size: 11px; color: #d0e0f5;',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        timeRow.add_child(this._currentTimeLabel);
        timeRow.add_child(totalTimeLabel);
        rightBox.add_child(timeRow);

        rightBox.add_child(this._createControls(player));

        return rightBox;
    }

    _createArtFrame(player, { glass, glow }) {
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
                background-color: rgba(0, 0, 0, 0);
            `,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        artFrame.add_child(artIcon);
        artFrame.set_pivot_point(0.5, 0.5);
        this._artFrame = artFrame;
        this._artContent = null;
        this._artReady = !player.artUrl;

        if (player.artUrl) {
            let file = null;
            try {
                file = Gio.File.new_for_uri(player.artUrl);
            } catch (_e) {
                // Keep the generic fallback icon if the player gives a bad art URL.
            }

            if (file) {
                const cancellable = new Gio.Cancellable();
                artFrame.connect('destroy', () => cancellable.cancel());
                // Keep the fallback hidden while loading so it doesn't
                // flash as "not found"; it only reappears on failure.
                artIcon.opacity = 0;
                file.load_contents_async(cancellable, (f, res) => {
                    if (cancellable.is_cancelled()) return;
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
                        this._artReady = true;
                        this._animateArtworkFlip();
                        return;
                    }

                    const color = _getArtworkGlow(pixbuf);
                    if (color) {
                        glow.set_style(`${glow.get_style()}
                            background-gradient-direction: vertical;
                            background-gradient-start: rgba(${color}, 0);
                            background-gradient-end: rgba(${color}, 0.14);
                        `);
                        glass.set_style(`${glass.get_style()}
                            border-bottom-color: rgba(${color}, 0.24);
                        `);
                    }

                    // St.Icon lost its pixbuf setter on newer shells, so the
                    // rounded art is shown as raw RGBA in an StImageContent —
                    // the same content type St.TextureCache fills.
                    const rounded = _roundArtPixbuf(pixbuf, 125, 20);
                    const content = new St.ImageContent({
                        preferredWidth: rounded.get_width(),
                        preferredHeight: rounded.get_height(),
                    });
                    try {
                        const coglContext = [];
                        const mutterBackend = global.stage?.context?.get_backend?.();
                        if (content.set_bytes.length === 6 && mutterBackend?.get_cogl_context)
                            coglContext.push(mutterBackend.get_cogl_context());

                        const bytes = rounded.get_data_as_bytes
                            ? rounded.get_data_as_bytes()
                            : new GLib.Bytes(rounded.get_pixels());
                        content.set_bytes(
                            ...coglContext,
                            bytes,
                            Cogl.PixelFormat.RGBA_8888,
                            rounded.get_width(),
                            rounded.get_height(),
                            rounded.get_rowstride());
                    } catch (_e) {
                        artIcon.opacity = 255;
                        this._artReady = true;
                        this._animateArtworkFlip();
                        return;
                    }

                    const artImage = new Clutter.Actor({
                        content,
                        width: 125,
                        height: 125,
                    });
                    artImage.set_position(0, 0);
                    artFrame.insert_child_at_index(artImage, 1);
                    this._artContent = content;
                    this._artReady = true;
                    this._animateArtworkFlip();
                    // The fallback stays hidden behind the art — it would
                    // show through the transparent rounded corners.
                });
            } else {
                this._artReady = true;
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

        const barBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 2px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const bars = [];
        const lowScales = [0.25, 0.35, 0.50, 0.30, 0.20];
        const highScales = [0.65, 0.95, 1.0, 0.85, 0.60];
        const restingScales = [0.25, 0.45, 0.65, 0.45, 0.25];
        const barSpeeds = [480, 400, 520, 440, 500];

        for (let i = 0; i < lowScales.length; i++) {
            const bar = new St.Widget({
                style_class: 'dinamic-status-bar',
                y_align: Clutter.ActorAlign.CENTER,
                opacity: i === 0 || i === lowScales.length - 1 ? 200 : 255,
            });
            bar.set_pivot_point(0.5, 0.5);
            bar.set_scale(1, isPlaying ? lowScales[i] : restingScales[i]);
            bars.push(bar);
            barBox.add_child(bar);
        }

        // Animate around the center without resizing the title row.
        if (isPlaying) {
            this._eqActive = true;
            bars.forEach((bar, i) => {
                const animateUp = () => {
                    if (!this._eqActive || !bar.get_parent()) return;
                    bar.ease({
                        scale_y: highScales[i],
                        duration: barSpeeds[i],
                        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                        onComplete: () => animateDown(),
                    });
                };
                const animateDown = () => {
                    if (!this._eqActive || !bar.get_parent()) return;
                    bar.ease({
                        scale_y: lowScales[i],
                        duration: barSpeeds[i],
                        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                        onComplete: () => animateUp(),
                    });
                };

                // Stagger bar starts so they move at different phases
                const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, i * 70, () => {
                    this._eqTimers = this._eqTimers.filter(timer => timer !== id);
                    animateUp();
                    return GLib.SOURCE_REMOVE;
                });
                this._eqTimers.push(id);
            });
        }

        return new St.Bin({
            style: 'margin-right: 8px;',
            child: barBox,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: isPlaying ? 'Playing' : 'Paused',
        });
    }

    _createControls(player) {
        const controls = new St.BoxLayout({
            style: 'spacing: 14px; padding-top: 2px;',
            x_align: Clutter.ActorAlign.CENTER,
        });

        controls.add_child(this._makeButton('media-skip-backward-symbolic', () => this._skipTrack('Previous')));

        this._playPauseIcon = new St.Icon({
            icon_name: player.status === 'Playing'
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic',
            style: 'width: 32px; height: 32px;',
            icon_size: 32,
        });
        const playPauseButton = new St.Button({
            style_class: 'dinamic-control-button dinamic-primary-button',
            style: this._getButtonStyle(true),
            child: this._playPauseIcon,
            reactive: true,
            can_focus: true,
            track_hover: true,
            accessible_name: player.status === 'Playing' ? 'Pause' : 'Play',
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

        controls.add_child(this._makeButton('media-skip-forward-symbolic', () => this._skipTrack('Next')));
        return controls;
    }

    _skipTrack(method) {
        this._artFlipDirection = method === 'Previous' ? -1 : 1;
        this._onControl(method);
    }

    _animateArtworkFlip() {
        const art = this._artFrame;
        const flip = this._artFlip;
        if (!art || !flip) return;

        if (flip.actor !== art) {
            flip.actor = art;
            if (flip.phase !== 'in') {
                flip.overlay = flip.content
                    ? new Clutter.Actor({ content: flip.content, width: 125, height: 125 })
                    : new St.Icon({ icon_name: 'audio-x-generic-symbolic', icon_size: 118 });
                art.add_child(flip.overlay);
            }
        }

        const isCurrent = () => this._artFrame === art && this._artFlip === flip;
        art.remove_transition('rotation-angle-y');
        if (flip.phase === 'out') {
            const elapsed = (GLib.get_monotonic_time() - flip.startedAt) / 1000;
            const progress = Math.min(1, elapsed / CONFIG.artFlipDuration);
            art.rotation_angle_y = flip.direction * 90 * progress ** 2;
            if (progress < 1) {
                art.ease({
                    rotation_angle_y: flip.direction * 90,
                    duration: CONFIG.artFlipDuration - elapsed,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        if (!isCurrent()) return;
                        flip.phase = 'waiting';
                        this._animateArtworkFlip();
                    },
                });
                return;
            }
            flip.phase = 'waiting';
        }

        // Swap faces at the edge, after the new cover has loaded. Never
        // expose a mirrored back face or reveal an empty loading frame.
        if (flip.phase === 'waiting') {
            art.rotation_angle_y = flip.direction * 90;
            if (!this._artReady) return;
            flip.overlay?.destroy();
            flip.overlay = null;
            flip.phase = 'in';
            flip.startedAt = GLib.get_monotonic_time();
        }
        if (!this._artReady) {
            art.rotation_angle_y = -flip.direction * 90;
            flip.startedAt = null;
            return;
        }

        flip.startedAt ??= GLib.get_monotonic_time();
        const elapsed = (GLib.get_monotonic_time() - flip.startedAt) / 1000;
        const progress = Math.min(1, elapsed / CONFIG.artFlipDuration);
        art.rotation_angle_y = -flip.direction * 90 * (1 - progress) ** 3;
        art.ease({
            rotation_angle_y: 0,
            duration: Math.max(0, CONFIG.artFlipDuration - elapsed),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (!isCurrent()) return;
                art.rotation_angle_y = 0;
                this._artFlip = null;
            },
        });
    }

    _makeButton(iconName, callback) {
        const icon = new St.Icon({
            icon_name: iconName,
            style: 'width: 28px; height: 28px;',
            icon_size: 28,
        });
        const button = new St.Button({
            style_class: 'dinamic-control-button dinamic-secondary-button',
            style: this._getButtonStyle(false),
            child: icon,
            reactive: true,
            can_focus: true,
            track_hover: true,
            accessible_name: iconName === 'media-skip-backward-symbolic' ? 'Previous track' : 'Next track',
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

    // Compact standalone trigger for the player dropdown: its own chrome
    // actor below the popup, so the selector isn't part of the popup frame.
    _createPlayerPill(players, activePlayer) {
        const statusRank = { Playing: 0, Paused: 1 };
        const sorted = [...players].sort((a, b) =>
            (statusRank[a.status] ?? 2) - (statusRank[b.status] ?? 2));

        // The pill previews the other player — never the one the popup
        // shows — so the selector always offers something new. Sorting
        // Playing players first picks a playing app when there is one.
        const display = sorted.find(p => p.busName !== activePlayer.busName) || activePlayer;

        const icon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 16,
            style: 'width: 16px; height: 16px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (display.appIconName) {
            icon.gicon = Gio.ThemedIcon.new_with_default_fallbacks(display.appIconName);
        }

        const label = new St.Label({
            text: _prettyPlayerName(display),
            style: `font-size: 12px; font-weight: 600; color: ${THEME.mutedText};`,
        });
        label.clutter_text.set_ellipsize(3);

        const sepLabel = new St.Label({
            text: '·',
            style: `font-size: 12px; font-weight: 600; color: ${THEME.dimText};`,
        });

        const songLabel = new St.Label({
            text: display.title || '',
            style: `font-size: 12px; color: ${THEME.dimText};`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        songLabel.clutter_text.set_ellipsize(3);

        const arrow = new St.Icon({
            icon_name: 'pan-down-symbolic',
            icon_size: 14,
            style: 'width: 14px; height: 14px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Stack the glass surface behind a vertical content box. Keeping
        // the width constrained lets long titles ellipsize inside the pill.
        const pill = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'dinamic-player-pill',
            style: `
                border-radius: 22px;
                width: ${CONFIG.width}px;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.20);
            `,
            reactive: true,
            can_focus: true,
            track_hover: true,
            opacity: 0,
        });
        this._addGlassBackground(pill, 22);
        this._playerPillContent = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'padding: 12px 16px;',
            x_expand: true,
            y_expand: true,
        });
        pill.add_child(this._playerPillContent);

        const trigger = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 8px;',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        trigger.add_child(icon);
        trigger.add_child(label);
        trigger.add_child(sepLabel);
        trigger.add_child(songLabel);
        trigger.add_child(arrow);
        this._playerPillContent.add_child(trigger);

        // Only the trigger row opens/toggles the dropdown — the pill
        // itself stays click-free so the player rows own their clicks.
        trigger.connect('button-press-event', () => {
            if (this._playerMenuOpen) {
                console.log('[nowplay] trigger press: close');
                this._closePlayerMenu();
            } else {
                console.log('[nowplay] trigger press: open');
                this._openPlayerMenu(sorted, activePlayer);
            }
            return Clutter.EVENT_STOP;
        });

        // The pill behaves like part of the popup for close timing: entering
        // it cancels the close, leaving it (with no menu open) starts it.
        pill.connect('enter-event', () => {
            this._clearCloseTimer();
            return Clutter.EVENT_PROPAGATE;
        });
        pill.connect('leave-event', () => {
            if (!this._playerMenuOpen)
                this._scheduleClose(CONFIG.popupLeaveCloseDelay);
            return Clutter.EVENT_PROPAGATE;
        });
        pill.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape && this._playerMenuOpen) {
                this._closePlayerMenu();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Size is only known after the first allocation; place it centered
        // under the popup then (the popup's position is stable from showPopup).
        pill.connect('notify::height', () => this._placePlayerPill());

        this._playerPill = pill;
        Main.layoutManager.addChrome(pill, { trackFullscreen: true });
    }

    _placePlayerPill() {
        if (!this._playerPill || !this._popup) return;

        const [px, py] = this._popup.get_position();
        const pw = this._popup.get_width() || CONFIG.width;
        const ph = this._popup.get_height() || CONFIG.height;

        // Force the exact popup width — belt and braces on the CSS width,
        // so the pill can never render wider than the popup.
        this._playerPill.set_width(pw);
        this._playerPill.set_position(
            px + Math.floor((pw - this._playerPill.get_width()) / 2),
            py + ph + 10);

        if (this._playerPill.opacity === 0) {
            // Same entrance as the popup: fade + pop-in scale.
            this._playerPill.set_pivot_point(0.5, 0.5);
            this._playerPill.set_scale(0.32, 0.52);
            this._playerPill.ease({
                opacity: 255,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            this._playerPill.ease({
                scale_x: 1,
                scale_y: 1,
                duration: CONFIG.animDuration,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }
    }

    // Animated exit on popup close, silent on content rebuild (the popup
    // stays visible, so a shrinking pill would look broken). Same contract
    // as _destroyPlayerMenu: no close-timer re-arm.
    _destroyPlayerPill(animate = false) {
        if (!this._playerPill) return;

        const pill = this._playerPill;
        this._playerPill = null;
        this._playerPillContent = null;

        if (animate && CONFIG.animCloseDuration > 0) {
            pill.ease({
                scale_x: 0.38,
                scale_y: 0.48,
                duration: CONFIG.animCloseDuration,
                mode: Clutter.AnimationMode.EASE_IN_BACK,
            });
            pill.ease({
                opacity: 0,
                duration: Math.round(CONFIG.animCloseDuration * 0.6),
                delay: Math.round(CONFIG.animCloseDuration * 0.4),
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => this._removePlayerPill(pill),
            });
        } else {
            this._removePlayerPill(pill);
        }
    }

    _removePlayerPill(pill) {
        if (!pill.get_parent()) return;

        Main.layoutManager.removeChrome(pill);
        pill.destroy();
    }

    // The dropdown expands inside the pill card itself (a modern select
    // look): opening appends the player rows under the trigger row, so the
    // same frame grows downward. An invisible full-monitor grab underneath
    // closes it on outside click.
    _openPlayerMenu(players, activePlayer) {
        this._destroyPlayerMenu();

        const monitor = Main.layoutManager.primaryMonitor;

        // The grab must sit UNDER the card so the card keeps its clicks:
        // add the grab first, then re-raise the card above it.
        this._playerGrab = new St.Widget({
            reactive: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            style: 'background-color: rgba(0, 0, 0, 0);',
        });
        this._playerGrab.connect('button-press-event', () => {
            this._closePlayerMenu();
            return Clutter.EVENT_STOP;
        });
        Main.layoutManager.addChrome(this._playerGrab);

        Main.layoutManager.removeChrome(this._playerPill);
        Main.layoutManager.addChrome(this._playerPill, { trackFullscreen: true });

        const items = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: `
                spacing: 2px;
                margin-top: 8px;
                padding-top: 8px;
                border-top: 1px solid rgba(255, 255, 255, 0.10);
            `,
            opacity: 0,
        });
        for (const player of players) {
            items.add_child(this._createPlayerMenuItem(player,
                player.busName === activePlayer.busName, activePlayer));
        }

        this._playerPillContent.add_child(items);
        this._playerMenu = items;
        this._playerMenuOpen = true;
        this._clearCloseTimer();
        this._playerPill.grab_key_focus();

        // The card grows downward from the same top edge; animate the rows in.
        // (Note: St widgets have no set_scale_y() in GJS — use two-arg
        // set_scale() like the popup's entrance.)
        items.set_pivot_point(0.5, 0);
        items.set_scale(1, 0.9);
        items.ease({
            opacity: 255,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        items.ease({
            scale_y: 1,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _createPlayerMenuItem(player, isActive, activePlayer) {
        const icon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 16,
            style: 'width: 16px; height: 16px;',
        });
        if (player.appIconName) {
            icon.gicon = Gio.ThemedIcon.new_with_default_fallbacks(player.appIconName);
        }

        const name = new St.Label({
            text: _prettyPlayerName(player),
            style: `font-size: 12px; font-weight: 700; color: ${THEME.text};`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        name.clutter_text.set_ellipsize(3);

        const song = new St.Label({
            text: player.title || '',
            style: `font-size: 11px; color: ${THEME.dimText};`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        song.clutter_text.set_ellipsize(3);

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 10px;',
            x_expand: true,
        });
        box.add_child(icon);
        box.add_child(name);
        box.add_child(song);

        // Only the controlled player's row dances when it's actually
        // playing — other rows that report Playing stay still, so exactly
        // one animation shows. Otherwise the controlled row gets the check.
        if (player.status === 'Playing' && player.busName === activePlayer.busName)
            box.add_child(this._createMenuEq());
        else if (isActive) {
            box.add_child(new St.Icon({
                icon_name: 'object-select-symbolic',
                icon_size: 14,
                style: `width: 14px; height: 14px; color: ${THEME.accent};`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const item = new St.Button({
            style_class: 'dinamic-player-menu-item',
            style: `
                border-radius: ${THEME.radius}px;
                padding: 10px 12px;
            `,
            child: box,
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
        });
        item.connect('clicked', () => {
            console.log(`[nowplay] item clicked: ${player.busName}`);
            this._closePlayerMenu();
            this._playerSelected = true;
            this._onSelectPlayer(player.busName);
            this._scheduleClose(CONFIG.autoCloseDelay);
        });
        return item;
    }

    // Mini animated equalizer for the playing row, accent-colored. Only the
    // startup timeouts are tracked; the ease chain dies with the bars.
    _createMenuEq() {
        const barBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 2px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const heights = [5, 2, 6];
        const scales = [1.8, 1.3, 2.2];
        const speeds = [420, 360, 500];

        heights.forEach((base, i) => {
            const bar = new St.Widget({
                style: `
                    width: 3px;
                    min-height: 4px;
                    height: ${base}px;
                    background-color: ${THEME.accent};
                    border-radius: 2px;
                `,
            });
            bar.set_pivot_point(0.5, 1.0);
            barBox.add_child(bar);

            const animateUp = () => {
                if (!bar.get_parent()) return;
                bar.ease({
                    scale_y: scales[i],
                    duration: speeds[i],
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    onComplete: () => animateDown(),
                });
            };
            const animateDown = () => {
                if (!bar.get_parent()) return;
                bar.ease({
                    scale_y: 1.0,
                    duration: speeds[i],
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    onComplete: () => animateUp(),
                });
            };

            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, i * 90, () => {
                this._menuEqTimers = this._menuEqTimers.filter(timer => timer !== id);
                animateUp();
                return GLib.SOURCE_REMOVE;
            });
            this._menuEqTimers.push(id);
        });

        return barBox;
    }

    // User-facing close: tears the dropdown down, then re-arms the popup
    // close timer based on where the pointer is.
    _closePlayerMenu() {
        const hadMenu = this._playerMenu !== null;
        this._destroyPlayerMenu();
        if (!hadMenu) return;

        if (this._popup) {
            this._popup.grab_key_focus();
            const delay = this._pointerInsidePopup() || this._pointerInsidePlayerPill()
                ? CONFIG.autoCloseDelay
                : CONFIG.popupLeaveCloseDelay;
            this._scheduleClose(delay);
        }
    }

    _pointerInsidePopup() {
        if (!this._popup) return true;

        const [x, y] = global.get_pointer();
        const [px, py] = this._popup.get_transformed_position();
        const pw = this._popup.get_width();
        const ph = this._popup.get_height();

        return x >= px && x <= px + pw && y >= py && y <= py + ph;
    }

    _pointerInsidePlayerPill() {
        if (!this._playerPill) return false;

        const [x, y] = global.get_pointer();
        const [px, py] = this._playerPill.get_transformed_position();
        const pw = this._playerPill.get_width();
        const ph = this._playerPill.get_height();

        return x >= px && x <= px + pw && y >= py && y <= py + ph;
    }

    // Silent teardown (no close-timer re-arm): the menu rows live inside
    // the pill card, so removing them just shrinks the card back. The grab
    // is chrome and must be removed explicitly.
    _destroyPlayerMenu() {
        this._menuEqTimers.forEach(id => GLib.source_remove(id));
        this._menuEqTimers = [];

        if (this._playerMenu) {
            this._playerMenu.destroy();
            this._playerMenu = null;
        }
        if (this._playerGrab) {
            Main.layoutManager.removeChrome(this._playerGrab);
            this._playerGrab.destroy();
            this._playerGrab = null;
        }

        this._playerMenuOpen = false;
    }

    _getPopupStyle() {
        return `
            border-radius: ${THEME.radius}px;
            box-shadow: 0 12px 36px rgba(0, 0, 0, 0.28);
            width: ${CONFIG.width}px;
            height: ${CONFIG.height}px;
        `;
    }

    _getButtonStyle(primary) {
        const size = primary ? 44 : 36;

        return `
            padding: 0;
            color: ${THEME.text};
            width: ${size}px;
            height: ${size}px;
        `;
    }

    _addGlassBackground(actor, radius) {
        const background = new St.Widget({
            x_expand: true,
            y_expand: true,
        });
        actor.add_child(background);

        // A separate lower band keeps the artwork tint out of the center.
        // Both gradient stops use the same hue so only opacity increases.
        const glow = actor === this._popup ? new St.Widget({
            style_class: 'dinamic-art-glow',
            style: `height: 64px; border-radius: 0 0 ${radius}px ${radius}px;`,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.END,
        }) : null;
        if (glow)
            actor.add_child(glow);

        // Keep the tint above the blur so the dark-to-clear gradient is
        // composited over the sampled desktop rather than into the effect.
        const glass = new St.Widget({
            style_class: 'dinamic-glass-background',
            style: `
                border: 1px solid ${THEME.border};
                border-top-color: rgba(255, 255, 255, 0.36);
                border-bottom-color: rgba(255, 255, 255, 0.30);
                border-radius: ${radius}px;
            `,
            x_expand: true,
            y_expand: true,
        });
        actor.add_child(glass);

        // Only the backing actor gets the effect, keeping text and controls
        // sharp. Its effect and signal connection die with the surface.
        if (RoundedBlur) {
            const context = St.ThemeContext.get_for_stage(global.stage);
            const effect = new RoundedBlur.BlurEffect({
                mode: RoundedBlur.BlurMode.BACKGROUND,
                brightness: 0.95,
                radius: 96 * context.scale_factor,
                corner_radius: radius * context.scale_factor,
            });
            background.add_effect(effect);
            context.connectObject('notify::scale-factor', () => {
                effect.radius = 96 * context.scale_factor;
                effect.corner_radius = radius * context.scale_factor;
            }, background);
        }

        return { glass, glow };
    }

    _formatTime(usec) {
        if (!usec || usec <= 0) return '0:00';

        const sec = Math.floor(usec / 1_000_000);
        return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, '0')}`;
    }
}
