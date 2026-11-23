// controls.js — input for desktop (WASD + pointer-lock mouse) and mobile
// (left virtual joystick, right-side drag to look, FIRE / RELOAD buttons).
//
// The module owns raw input state only; main.js decides what the input
// means (moving, firing, spectating) based on the game state.

export class Controls {
  constructor({ onReload, onMap, onFullscreen, onClimb } = {}) {
    this.onReload = onReload || (() => {});
    this.onMap = onMap || (() => {});
    this.onFullscreen = onFullscreen || (() => {});
    this.onClimb = onClimb || (() => {});
    // Coarse pointer = a phone or tablet. Touchscreen laptops report touch
    // capability too, but their primary pointer is the mouse: treating them
    // as touch devices covers the screen with touch zones that swallow mouse
    // clicks, which breaks pointer lock and firing entirely.
    this.isTouch = window.matchMedia('(pointer: coarse)').matches;
    this.keys = new Set();
    this.fireQueued = false; // a FIRE press waiting to be consumed (semi-auto: one shot per press)
    this.aiming = false; // right mouse held (desktop) or AIM toggled (mobile)
    this.crouch = false; // C toggled (desktop) or CROUCH toggled (mobile)
    this.locked = false;
    this.lookDX = 0;
    this.lookDY = 0;
    // Joystick state (mobile).
    this.joyActive = false;
    this.joyId = null;
    this.joyBaseX = 0;
    this.joyBaseY = 0;
    this.joyX = 0; // -1..1 strafe (right positive)
    this.joyY = 0; // -1..1 forward (up positive)
    // Look-drag state (mobile).
    this.lookId = null;
    this.lookLastX = 0;
    this.lookLastY = 0;
    this.canvas = null;
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onLockChange = this._onLockChange.bind(this);
  }

  attach(canvas, els) {
    this.canvas = canvas;
    this.els = els; // { joyZone, joyBase, joyKnob, lookZone, fireBtn, reloadArrow, aimBtn }
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('pointerlockchange', this._onLockChange);
    if (this.isTouch) this._attachTouch();
  }

  requestLock() {
    if (!this.isTouch && this.canvas && document.pointerLockElement !== this.canvas) {
      const r = this.canvas.requestPointerLock();
      if (r && r.catch) r.catch(() => { /* lock failed (e.g. ESC cooldown); next click retries */ });
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // Movement intent: { x: strafe right +, z: forward + }, each -1..1.
  getMove() {
    let x = 0;
    let z = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.joyActive) {
      x += this.joyX;
      z += this.joyY;
    }
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    return { x, z };
  }

  // Consume accumulated look deltas (pixels) since the last frame.
  takeLook() {
    const out = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = 0;
    this.lookDY = 0;
    return out;
  }

  // Consume a queued FIRE press (semi-auto): true once per press, even
  // if the press and release happened between frames. The loop consumes
  // it every frame, so a press while dead is discarded, never fired late.
  takeFirePress() {
    const pressed = this.fireQueued;
    this.fireQueued = false;
    return pressed;
  }

  _onLockChange() {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) this.fireQueued = false;
  }

  _onMouseMove(e) {
    if (!this.locked) return;
    this.lookDX += e.movementX || 0;
    this.lookDY += e.movementY || 0;
  }

  _onMouseDown(e) {
    // Fire when locked, or on a canvas click while unlocked (the click also
    // locks the pointer, so the first click both aims and fires). Clicks on
    // HUD buttons do not fire. Semi-auto: the press queues one shot.
    if (e.button === 0 && (this.locked || e.target === this.canvas)) this.fireQueued = true;
    if (e.button === 2) this.aiming = true;
  }

  _onMouseUp(e) {
    if (e.button === 2) this.aiming = false;
  }

  _onKeyDown(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
      e.preventDefault();
    }
    if (e.code === 'KeyR' && !e.repeat) this.onReload();
    if (e.code === 'KeyM' && !e.repeat) this.onMap();
    if (e.code === 'KeyF' && !e.repeat) this.onFullscreen();
    if (e.code === 'KeyE' && !e.repeat) this.onClimb();
    if (e.code === 'KeyC' && !e.repeat) this.crouch = !this.crouch;
    this.keys.add(e.code);
  }

  _onKeyUp(e) {
    this.keys.delete(e.code);
  }

  _attachTouch() {
    const { joyZone, joyBase, joyKnob, lookZone, fireBtn, reloadArrow, aimBtn, crouchBtn } = this.els;
    const RADIUS = 48; // joystick travel in px

    const setKnob = (dx, dy) => {
      joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    joyZone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this.joyActive = true;
      this.joyId = t.identifier;
      this.joyBaseX = t.clientX;
      this.joyBaseY = t.clientY;
      joyBase.style.display = 'block';
      joyBase.style.left = `${t.clientX - 60}px`;
      joyBase.style.top = `${t.clientY - 60}px`;
      setKnob(0, 0);
    }, { passive: false });

    joyZone.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== this.joyId) continue;
        let dx = t.clientX - this.joyBaseX;
        let dy = t.clientY - this.joyBaseY;
        const len = Math.hypot(dx, dy);
        if (len > RADIUS) {
          dx = (dx / len) * RADIUS;
          dy = (dy / len) * RADIUS;
        }
        this.joyX = dx / RADIUS;
        this.joyY = -dy / RADIUS; // pushing up moves forward
        setKnob(dx, dy);
      }
    }, { passive: false });

    const endJoy = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.joyId) {
          this.joyActive = false;
          this.joyId = null;
          this.joyX = 0;
          this.joyY = 0;
          joyBase.style.display = 'none';
        }
      }
    };
    joyZone.addEventListener('touchend', endJoy);
    joyZone.addEventListener('touchcancel', endJoy);

    lookZone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this.lookId = t.identifier;
      this.lookLastX = t.clientX;
      this.lookLastY = t.clientY;
    }, { passive: false });

    lookZone.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== this.lookId) continue;
        this.lookDX += (t.clientX - this.lookLastX) * 2.2;
        this.lookDY += (t.clientY - this.lookLastY) * 2.2;
        this.lookLastX = t.clientX;
        this.lookLastY = t.clientY;
      }
    }, { passive: false });

    const endLook = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.lookId) this.lookId = null;
      }
    };
    lookZone.addEventListener('touchend', endLook);
    lookZone.addEventListener('touchcancel', endLook);

    const bindHold = (el, on, off) => {
      el.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); on(); }, { passive: false });
      el.addEventListener('touchend', (e) => { e.preventDefault(); off(); }, { passive: false });
      el.addEventListener('touchcancel', off);
    };
    bindHold(fireBtn, () => { this.fireQueued = true; }, () => {}); // semi-auto: press queues one shot
    // Reload arrow: swipe right-to-left along it to reload. The swipe
    // fires once the finger has travelled half the arrow's width
    // (105 px); a plain tap does nothing, so the reload can't fire by
    // accident mid-fight.
    if (reloadArrow) {
      let swipeId = null;
      let swipeStartX = 0;
      let swipeFired = false;
      reloadArrow.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const t = e.changedTouches[0];
        swipeId = t.identifier;
        swipeStartX = t.clientX;
        swipeFired = false;
      }, { passive: false });
      reloadArrow.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) {
          if (t.identifier !== swipeId || swipeFired) continue;
          if (swipeStartX - t.clientX >= 105) {
            swipeFired = true;
            this.onReload();
          }
        }
      }, { passive: false });
      const endSwipe = (e) => {
        for (const t of e.changedTouches) {
          if (t.identifier === swipeId) swipeId = null;
        }
      };
      reloadArrow.addEventListener('touchend', endSwipe);
      reloadArrow.addEventListener('touchcancel', endSwipe);
    }
    if (aimBtn) {
      aimBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.aiming = !this.aiming;
        aimBtn.classList.toggle('active', this.aiming);
      }, { passive: false });
    }
    if (crouchBtn) {
      crouchBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.crouch = !this.crouch;
        crouchBtn.classList.toggle('active', this.crouch);
      }, { passive: false });
    }
  }
}
