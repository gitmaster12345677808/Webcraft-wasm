'use strict';

// These are relative paths
const RELEASE_DIR = '%__RELEASE_UUID__%'; // set by build_www.sh
const DEFAULT_PACKS_DIR = RELEASE_DIR + '/packs';

const rtCSS = `
body {
  font-family: arial;
  margin: 0;
  padding: none;
  background-color: black;
}

.emscripten {
  color: #aaaaaa;
  padding-right: 0;
  margin-left: auto;
  margin-right: auto;
  display: block;
}

div.emscripten {
  text-align: center;
  width: 100%;
}

/* the canvas *must not* have any border or padding, or mouse coords will be wrong */
canvas.emscripten {
  border: 0px none;
  background-color: black;
}

#controls {
  display: inline-block;
  vertical-align: top;
	height: 25px;
}

.console {
  width: 100%;
  margin: 0 auto;
  margin-top: 0px;
  border-left: 0px;
  border-right: 0px;
  padding-left: 0px;
  padding-right: 0px;
  display: block;
  background-color: black;
  color: white;
  font-family: 'Lucida Console', Monaco, monospace;
  outline: none;
}
`;

const rtHTML = `
  <div id="header">

  <div class="emscripten">
    <span id="controls">
      <span>
        <select id="resolution" onchange="fixGeometry()">
          <option value="high">High Res</option>
          <option value="medium">Medium</option>
          <option value="low">Low Res</option>
        </select>
      </span>
      <span>
        <select id="aspectRatio" onchange="fixGeometry()">
          <option value="any">Fit Screen</option>
          <option value="4:3">4:3</option>
          <option value="16:9">16:9</option>
          <option value="5:4">5:4</option>
          <option value="21:9">21:9</option>
          <option value="32:9">32:9</option>
          <option value="1:1">1:1</option>
        </select>
      </span>
      <span><input id="console_button" type="button" value="Show Console" onclick="consoleToggle()"></span>
      <span>(full screen: try F11 or Command+Shift+F)</span>
    </span>
    <div id="progressbar_div" style="display: none">
      <progress id="progressbar" value="0" max="100">0%</progress>
    </div>
  </div>

  </div>

  <div class="emscripten" id="canvas_container">
  </div>

  <div id="footer">
    <textarea id="console_output" class="console" rows="8" style="display: none; height: 200px"></textarea>
  </div>
`;

// The canvas needs to be created before the wasm module is loaded.
// It is not attached to the document until activateBody()
const mtCanvas = document.createElement('canvas');
mtCanvas.className = "emscripten";
mtCanvas.id = "canvas";
mtCanvas.oncontextmenu = (event) => {
  event.preventDefault();
};
mtCanvas.tabIndex = "-1";
mtCanvas.width = 1024;
mtCanvas.height = 600;

// Global flags used by UI/layout code to avoid focusing the canvas
// while the mobile/native or the JS on-screen keyboard are active.
// These are intentionally globals so top-level helpers such as
// fixGeometry() can access them safely regardless of whether
// createMobileControls() has run or not.
var mobileKeyboardActive = false;
var jsKeyboardActive = false;

var consoleButton;
var consoleOutput;
var progressBar;
var progressBarDiv;

function activateBody() {
    const extraCSS = document.createElement("style");
    extraCSS.innerText = rtCSS;
    document.head.appendChild(extraCSS);

    // Replace the entire body
    document.body.style = '';
    document.body.className = '';
    document.body.innerHTML = '';

    const mtContainer = document.createElement('div');
    mtContainer.innerHTML = rtHTML;
    document.body.appendChild(mtContainer);

    const canvasContainer = document.getElementById('canvas_container');
    canvasContainer.appendChild(mtCanvas);

    // Create an on-canvas mobile controls overlay for touch devices
    createMobileControls(canvasContainer, mtCanvas);

    setupResizeHandlers();

    consoleButton = document.getElementById('console_button');
    consoleOutput = document.getElementById('console_output');
    // Triggers the first and all future updates
    consoleUpdate();

    progressBar = document.getElementById('progressbar');
    progressBarDiv = document.getElementById('progressbar_div');
    updateProgressBar(0, 0);
}

// Mobile controls helper - overlays touch-friendly UI and maps touches to
// keyboard/mouse events so the wasm game receives input on mobile.
function createMobileControls(container, canvas) {
    // Only enable overlay on touch devices / small screens
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    // Detect iOS (includes iPadOS which can report Mac platform but still be touch-enabled)
    // Use both UA and the MacIntel+touch heuristic which is common for iPadOS.
    const isiOS = /iPad|iPhone|iPod/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!isTouch) return;

    const overlay = document.createElement('div');
    overlay.id = 'mobile_overlay';
    overlay.style = `
      position: absolute;
      left: 0; top: 0; right: 0; bottom: 0;
      pointer-events: none; /* allow underlying canvas when not interacting */
      z-index: 9999;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      padding: 12px;
    `;

    // left joystick
    const leftPad = document.createElement('div');
    leftPad.id = 'mobile_leftpad';
    leftPad.style = `
      pointer-events: auto;
      width: 36vmin; height: 36vmin; max-width: 260px; max-height: 260px;
      border-radius: 999px; background: rgba(0,0,0,0.18);
      display:flex; align-items:center; justify-content:center; margin:8px;
      touch-action: none; -webkit-user-select: none; user-select: none;
    `;
    // joystick thumb
    const leftThumb = document.createElement('div');
    leftThumb.style = `
      width: 24%; height: 24%; background: rgba(255,255,255,0.18);
      border-radius: 999px; transform: translate(0,0);
    `;
    leftPad.appendChild(leftThumb);

    // right pad for look/aim
    const rightPad = document.createElement('div');
    rightPad.id = 'mobile_rightpad';
    rightPad.style = `
      pointer-events: auto;
      width: 44vmin; height: 44vmin; max-width: 320px; max-height: 320px;
      border-radius: 20px; background: rgba(0,0,0,0.04);
      display:flex; align-items:center; justify-content:center; margin:8px;
      touch-action: none; -webkit-user-select: none; user-select: none;
    `;

    // right pad helper text
    const rightHint = document.createElement('div');
    rightHint.style = `color: rgba(255,255,255,0.6); font-size: 12px; text-align:center;`;
    rightHint.innerText = 'Drag to look — tap to interact';
    rightPad.appendChild(rightHint);

    // buttons cluster
        const buttons = document.createElement('div');
        buttons.style = `
            pointer-events: auto; display:flex; flex-direction:row; gap:12px; align-items:center; margin:18px; justify-content:center;
        `;
    const btnStyle = `
      pointer-events: auto; min-width: 58px; min-height: 58px; border-radius: 16px;
      background: rgba(0,0,0,0.22); color: white; display:flex; align-items:center; justify-content:center;
      box-shadow: 0 6px 18px rgba(0,0,0,0.4); font-weight:700; font-size:18px; touch-action: none;
    `;

    // Create two vertically stacked buttons: Jump (Space) and Use (right-click)
    const btnJump = document.createElement('button'); btnJump.id = 'mc_jump'; btnJump.innerText = 'Jump'; btnJump.style = btnStyle;
    const btnUse = document.createElement('button'); btnUse.id = 'mc_use'; btnUse.innerText = 'Use'; btnUse.style = btnStyle;

    // Inventory button (E key)
    const btnInv = document.createElement('button'); btnInv.id = 'mc_inv'; btnInv.innerText = 'Inv'; btnInv.title = 'Open Inventory (I)'; btnInv.style = btnStyle + ' font-size:14px; padding: 10px 14px;';

    // Hotbar arrows - horizontal left/right buttons
    const hbLeft = document.createElement('button'); hbLeft.id = 'mc_hbleft'; hbLeft.innerText = '◀'; hbLeft.title = 'Hotbar - previous'; hbLeft.style = btnStyle + ' width:48px; height:48px; font-size:20px;';
    const hbRight = document.createElement('button'); hbRight.id = 'mc_hbright'; hbRight.innerText = '▶'; hbRight.title = 'Hotbar - next'; hbRight.style = btnStyle + ' width:48px; height:48px; font-size:20px;';

    // place vertically (flex-direction: column already set on container)
    // layout order: Jump | Use | Inv | ◀ ▶
    buttons.appendChild(btnJump);
    buttons.appendChild(btnUse);
    buttons.appendChild(btnInv);
    buttons.appendChild(hbLeft);
    buttons.appendChild(hbRight);

    overlay.appendChild(leftPad);
    overlay.appendChild(buttons);
        overlay.appendChild(rightPad);

        // Replace Invite/Join with Chat, Menu (pause) and a Keyboard button.
        // Chat opens the in-game chat (T). Pause sends ESC to open the pause menu.
        // Keyboard will focus a hidden input so mobile keyboards appear for typing.
        const chatBtn = document.createElement('button');
        chatBtn.id = 'mc_chat';
        chatBtn.innerText = 'Chat';
        chatBtn.title = 'Open chat (T)';
        chatBtn.style = `
            position: absolute; left: 50%; transform: translateX(-50%); top: 12px;
            pointer-events: auto; padding: 8px 12px; border-radius: 12px; font-weight:700;
            background: rgba(0,0,0,0.22); color: #fff; z-index: 10000; border: none;
        `;
        container.appendChild(chatBtn);

        const menuBtn = document.createElement('button');
        menuBtn.id = 'mc_menu';
        menuBtn.innerText = 'Menu';
        menuBtn.title = 'Pause / Menu (Esc)';
        menuBtn.style = `
            position: absolute; left: calc(50% + 92px); transform: translateX(-50%); top: 12px;
            pointer-events: auto; padding: 8px 12px; border-radius: 12px; font-weight:700;
            background: rgba(0,0,0,0.22); color: #fff; z-index: 10000; border: none;
        `;
        container.appendChild(menuBtn);

        // Small keyboard button — focuses a hidden input to bring up the system keyboard
        const keyboardBtn = document.createElement('button');
        keyboardBtn.id = 'mc_keyboard';
        keyboardBtn.innerText = '⌨';
        keyboardBtn.title = 'Show keyboard';
        keyboardBtn.style = `
            position: absolute; left: calc(50% - 92px); transform: translateX(-50%); top: 12px;
            pointer-events: auto; padding: 8px 10px; border-radius: 12px; font-weight:700; font-size:16px;
            background: rgba(0,0,0,0.22); color: #fff; z-index: 10000; border: none;
        `;
        container.appendChild(keyboardBtn);

        // Secondary button to open the JS on-screen keyboard (useful on
        // mobile when you want the in-page keyboard instead of the OS one).
        const jsShowBtn = document.createElement('button');
        jsShowBtn.id = 'mc_js_show';
        jsShowBtn.innerText = 'JS';
        jsShowBtn.title = 'Show JS keyboard';
        jsShowBtn.style = `
            position: absolute; left: calc(50% - 128px); transform: translateX(-50%); top: 12px;
            pointer-events: auto; padding: 8px 8px; border-radius: 12px; font-weight:700; font-size:14px;
            background: rgba(0,0,0,0.22); color: #fff; z-index: 10000; border: none;
        `;
        container.appendChild(jsShowBtn);

        // Hidden input used to receive typed characters on mobile — kept off-screen
        const hiddenInput = document.createElement('input');
        hiddenInput.id = 'mc_text_input';
        hiddenInput.type = 'text';
        hiddenInput.autocapitalize = 'none';
        hiddenInput.autocomplete = 'off';
        hiddenInput.autocorrect = 'off';
        hiddenInput.spellcheck = false;
        // Keep the hidden input on-screen (but visually invisible) so mobile
        // browsers will show and keep the keyboard open when focused.
        hiddenInput.style = 'position:absolute; right:12px; bottom:12px; width:1px; height:1px; opacity:0; z-index:11000;';
        container.appendChild(hiddenInput);
        // Track mobile keyboard state so we don't refocus the canvas while typing.
        hiddenInput.addEventListener('focus', () => { mobileKeyboardActive = true; });
        hiddenInput.addEventListener('blur', () => { mobileKeyboardActive = false; });

        // Utility: synthesize a lowercase T key press (open chat)
        function sendLowercaseT() {
            try { if (!mobileKeyboardActive && !jsKeyboardActive) canvas.focus(); } catch (e) {}
            const code = 'KeyT';
            const keyChar = 't';
            const keyDownCode = 84; // 'T'
            const charCode = keyChar.charCodeAt(0);
            try {
                const ev = new KeyboardEvent('keydown', { code: code, key: keyChar, keyCode: keyDownCode, which: keyDownCode, bubbles: true, cancelable: true });
                canvas.dispatchEvent(ev); document.dispatchEvent(ev); window.dispatchEvent(ev);
            } catch (err) {}
            try {
                const kp = new KeyboardEvent('keypress', { key: keyChar, code: code, keyCode: charCode, which: charCode, charCode: charCode, bubbles: true, cancelable: true });
                canvas.dispatchEvent(kp); document.dispatchEvent(kp); window.dispatchEvent(kp);
            } catch (err) {}
            setTimeout(() => {
                try { const ev2 = new KeyboardEvent('keyup', { code: code, key: keyChar, keyCode: keyDownCode, which: keyDownCode, bubbles: true, cancelable: true }); canvas.dispatchEvent(ev2); document.dispatchEvent(ev2); window.dispatchEvent(ev2); } catch (err) {}
            }, 60);
        }

        // Pause menu — send an Escape keypress to the engine
        function sendEscapePress() {
            try { if (!mobileKeyboardActive && !jsKeyboardActive) canvas.focus(); } catch (e) {}
            try { sendKey('Escape', true); } catch (e) {}
            setTimeout(() => { try { sendKey('Escape', false); } catch (e) {} }, 60);
        }

        // Wire up the buttons
        chatBtn.addEventListener('click', (e) => { e.preventDefault(); sendLowercaseT(); showJSKeyboard(true); });
        menuBtn.addEventListener('click', (e) => { e.preventDefault(); sendEscapePress(); });
        // Focus input early on touchstart so virtual keyboards show reliably.
        // Special handling for iOS: some WebKit configurations require a user gesture
        // that actually focuses a visible/usable input and the engine's chat UI
        // may need to be opened first. To reliably type in game chat on iOS,
        // synthesize a single lowercase 't' to open the chat then focus the
        // hidden input so the OS keyboard appears and typing goes into chat.
        keyboardBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            try {
                if (isiOS) {
                    // If the mobile keyboard is already active, do nothing.
                    if (!mobileKeyboardActive && !jsKeyboardActive) {
                        // Send 't' to open chat prior to focusing the input so
                        // the game's chat box is visible when the keyboard opens.
                        try { sendLowercaseT(); } catch (err) {}
                        // Focus shortly after sending the chat key so the OS
                        // keyboard connects to the input (use a small delay).
                        setTimeout(() => { try { hiddenInput.focus(); } catch (err) {} }, 60);
                    } else {
                        try { hiddenInput.focus(); } catch (err) {}
                    }
                } else {
                    try { hiddenInput.focus(); } catch (err) {}
                }
            } catch (err) {}
        }, { passive:false });
        keyboardBtn.addEventListener('click', (e) => {
            e.preventDefault();
            try {
                if (isiOS) {
                    if (!mobileKeyboardActive && !jsKeyboardActive) {
                        try { sendLowercaseT(); } catch (err) {}
                        setTimeout(() => { try { hiddenInput.focus(); } catch (err) {} }, 60);
                    } else {
                        try { hiddenInput.focus(); } catch (err) {}
                    }
                } else {
                    try { hiddenInput.focus(); } catch (err) {}
                }
            } catch (err) {}
        });

        // Wire up JS-Show button: toggle the JS on-screen keyboard. When
        // opening, do not auto-send any 't' keys — instead wait until the
        // user starts typing so we avoid accidental / duplicate 't' input.
        let jsKeyboardNeedsChatOpen = false;
        function toggleJSKeyboard() {
            if (jsKeyboardActive) {
                hideJSKeyboard();
                jsKeyboardNeedsChatOpen = false;
            } else {
                // We want the chat to open the first time the user types,
                // but avoid synthesizing any key events just by opening the
                // keyboard UI.
                jsKeyboardNeedsChatOpen = true;
                showJSKeyboard(true);
            }
        }

        jsShowBtn.addEventListener('touchstart', (e) => { e.preventDefault(); try { toggleJSKeyboard(); } catch (err) {} }, { passive:false });
        jsShowBtn.addEventListener('click', (e) => { e.preventDefault(); try { toggleJSKeyboard(); } catch (err) {} });

        // Forward keyboard events from the hidden input to the canvas so typed
        // characters are delivered to the game while the chat UI has focus.
        // Some mobile keyboards (especially Android) don't reliably emit
        // keydown/keyup for printable characters; they emit `input` events.
        // Listen for `input` / composition events and synthesize key events
        // for every inserted character and backspace so chat receives typed
        // characters reliably.
        let hiddenInputPrevValue = '';
        let composing = false;
        hiddenInput.addEventListener('keydown', (e) => {
            // Prevent the input from handling the event itself
            e.stopPropagation();
            // Do not forward printable characters here — `input` events
            // will be used to synthesize character events (many mobile
            // keyboards don't emit per-character keydown/keyup). Also
            // skip Backspace because deletions are handled by `input`.
            const key = e.key;
            if (key && key.length === 1) return; // printable char — handled by input
            if (key === 'Backspace') return; // deletions handled by input diff

            // Convert non-printable keys into appropriate events for the canvas
            try {
                const key = e.key;
                let code = e.code || (key && key.length === 1 ? ('Key' + key.toUpperCase()) : key);
                const keyCode = key && key.length === 1 ? key.toUpperCase().charCodeAt(0) : (key === 'Enter' ? 13 : (key === 'Backspace' ? 8 : 0));
                const ev = new KeyboardEvent('keydown', { key: key, code: code, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true });
                canvas.dispatchEvent(ev); document.dispatchEvent(ev); window.dispatchEvent(ev);
            } catch (err) {}
            // Make sure pressing Enter hides keyboard (send Enter as keyup as well)
            if (e.key === 'Enter') {
                e.preventDefault();
                // Keep event forwarding consistent: ensure the engine receives
                // keyup for Enter (keydown was dispatched earlier in this handler)
                try { const ev2 = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }); canvas.dispatchEvent(ev2); document.dispatchEvent(ev2); window.dispatchEvent(ev2); } catch (err) {}
                // blur the input so mobile keyboard hides
                setTimeout(() => { try { hiddenInput.blur(); } catch (e) {} }, 10);
                // After a short delay, clear the message buffer so future
                // messages start fresh. Do this after the blur so mobile OS
                // orders are preserved.
                setTimeout(() => { try { hiddenInput.value = ''; hiddenInputPrevValue = ''; } catch (e) {} }, 120);
            }
        });

        hiddenInput.addEventListener('keyup', (e) => {
            e.stopPropagation();
            // Only forward non-printable keys here — printable characters
            // are sent via input() processing above. Skip Backspace (handled
            // by input) to avoid duplicate deletes.
            const key = e.key;
            if (key && key.length === 1) return;
            if (key === 'Backspace') return;
            try {
                let code = e.code || key;
                const keyCode = key === 'Enter' ? 13 : 0;
                const ev = new KeyboardEvent('keyup', { key: key, code: code, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true });
                canvas.dispatchEvent(ev); document.dispatchEvent(ev); window.dispatchEvent(ev);
            } catch (err) {}
            // Do not clear the input on every keyup — the value should be
            // preserved until the user submits via Enter so we can deliver
            // the full message reliably.
        });

        // Handle IME composition events (e.g., complex input) — wait until
        // compositionend to dispatch final characters.
        hiddenInput.addEventListener('compositionstart', (e) => {
            composing = true;
        });
        hiddenInput.addEventListener('compositionend', (e) => {
            composing = false;
            // treat the composition result like a normal input update
            handleInputEvent();
        });

        // Utility to convert single character to event properties
        function charToEventProps(ch) {
            if (!ch) return { key: ch, code: '', keyCode: ch.charCodeAt(0), charCode: ch.charCodeAt(0) };
            if (ch === ' ') return { key: ' ', code: 'Space', keyCode: 32, charCode: 32 };
            const isLetter = ch.match(/^[a-zA-Z]$/);
            const isDigit = ch.match(/^\d$/);
            if (isLetter) {
                const up = ch.toUpperCase();
                return { key: ch, code: 'Key' + up, keyCode: up.charCodeAt(0), charCode: ch.charCodeAt(0) };
            }
            if (isDigit) {
                return { key: ch, code: 'Digit' + ch, keyCode: ch.charCodeAt(0), charCode: ch.charCodeAt(0) };
            }
            // Generic fallback
            return { key: ch, code: '', keyCode: ch.charCodeAt(0), charCode: ch.charCodeAt(0) };
        }

        function sendCharEvents(ch) {
            const props = charToEventProps(ch);
            // Do not steal focus when our JS keyboard is active; synthetic
            // events are dispatched directly to the canvas so focus is not required.
            try {
                if (!jsKeyboardActive && !mobileKeyboardActive) canvas.focus();
            } catch (err) {}
            // Dispatch character keyboard events only to the canvas element
            // (the runtime listens on the canvas). Sending to document/window
            // can cause duplicate handling in some environments.
            try { const kd = new KeyboardEvent('keydown', { key: props.key, code: props.code, keyCode: props.keyCode, which: props.keyCode, bubbles: true, cancelable: true }); canvas.dispatchEvent(kd); } catch (err) {}
            try { const kp = new KeyboardEvent('keypress', { key: props.key, code: props.code, keyCode: props.charCode, which: props.charCode, charCode: props.charCode, bubbles: true, cancelable: true }); canvas.dispatchEvent(kp); } catch (err) {}
            setTimeout(() => { try { const ku = new KeyboardEvent('keyup', { key: props.key, code: props.code, keyCode: props.keyCode, which: props.keyCode, bubbles: true, cancelable: true }); canvas.dispatchEvent(ku); } catch (err) {} }, 6);
        }

        function sendBackspace() {
            try { if (!jsKeyboardActive && !mobileKeyboardActive) canvas.focus(); } catch (err) {}
            try { const kd = new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true }); canvas.dispatchEvent(kd); } catch (err) {}
            setTimeout(() => { try { const ku = new KeyboardEvent('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true }); canvas.dispatchEvent(ku); } catch (err) {} }, 6);
        }

        function handleInputEvent() {
            if (composing) return; // wait for compositionend
            const cur = hiddenInput.value || '';
            const prev = hiddenInputPrevValue || '';
            if (cur === prev) return; // nothing changed
            // Find common prefix
            let i = 0;
            while (i < cur.length && i < prev.length && cur[i] === prev[i]) i++;
            // Find common suffix
            let j1 = cur.length - 1;
            let j2 = prev.length - 1;
            while (j1 >= i && j2 >= i && cur[j1] === prev[j2]) { j1--; j2--; }
            const added = cur.slice(i, j1 + 1);
            const removed = prev.slice(i, j2 + 1);
            // Deleted characters -> send multiple backspaces
            if (removed.length > 0) {
                for (let k = 0; k < removed.length; k++) sendBackspace();
            }
            // Added characters -> send them one-by-one
            if (added.length > 0) {
                for (const ch of added) sendCharEvents(ch);
            }
            hiddenInputPrevValue = cur;
        }

        hiddenInput.addEventListener('input', (e) => {
            // When our JS keyboard is active we intentionally mirror the
            // buffer into the hidden input for state consistency, but we
            // must not forward `input` events to the engine (this would
            // cause duplicates). Ignore input events while JS keyboard
            // is active — native keyboards still work normally.
            if (jsKeyboardActive) return;
            handleInputEvent();
        });
        
        // --- JavaScript on-screen keyboard (shown when chat opens) ---
        const jsKb = document.createElement('div');
        jsKb.id = 'mc_js_keyboard';
        jsKb.style = `
            position: absolute; left: 50%; transform: translateX(-50%); bottom: 12px;
            width: calc(100% - 48px); max-width: 880px; z-index: 12000; display: none;
            background: rgba(0,0,0,0.62); border-radius: 12px; padding: 8px; box-shadow: 0 8px 28px rgba(0,0,0,0.6);
            color: #fff; font-family: Arial, sans-serif;
        `;

        // chat display row
        const kbDisplay = document.createElement('div');
        kbDisplay.id = 'mc_kb_display';
        kbDisplay.style = 'background: rgba(255,255,255,0.06); padding:8px 10px; border-radius:8px; min-height:34px; display:flex; align-items:center; gap:8px;';
        const kbText = document.createElement('div'); kbText.id = 'mc_kb_text'; kbText.style = 'flex:1; color:#fff; font-size:16px;'; kbText.innerText = '';
        const kbClear = document.createElement('button'); kbClear.innerText = '×'; kbClear.title = 'Clear'; kbClear.style = 'background:transparent; border:none; color:#fff; font-size:18px; padding:4px;';
        kbDisplay.appendChild(kbText); kbDisplay.appendChild(kbClear);
        jsKb.appendChild(kbDisplay);

        // keys: full-featured keyboard with number row, shift, caps, and symbol toggle
        const alphaRows = [ 'qwertyuiop', 'asdfghjkl', 'zxcvbnm' ];
        const numberRow = '1234567890';
        const symbolRows = [
            '!@#$%^&*()',
            "-+=/:;?[]{}",
            "'\"\\,._<>~`"
        ];

        const keysContainer = document.createElement('div');
        keysContainer.style = 'display:flex; flex-direction:column; gap:6px; margin-top:8px;';
        jsKb.appendChild(keysContainer);

        // Active keyboard state
        let shiftActive = false;
        let capsLock = false;
        let symbolMode = false;

        function buildRow(chars) {
            const row = document.createElement('div');
            row.style = 'display:flex; gap:6px; justify-content:center;';
            for (const ch of chars) {
                const b = document.createElement('button');
                b.className = 'mc_kb_key';
                // Display upper/lowercase depending on shift/caps for letters
                if (!symbolMode && /^[a-zA-Z]$/.test(ch)) {
                    const up = (capsLock && !shiftActive) || (!capsLock && shiftActive);
                    b.innerText = up ? ch.toUpperCase() : ch.toLowerCase();
                } else {
                    b.innerText = ch;
                }
                b.dataset.ch = ch;
                b.style = 'flex:0 0 36px; height:40px; border-radius:8px; background:rgba(255,255,255,0.06); color:#fff; border:none; font-size:16px;';
                // Support pointer events to avoid duplicated click syntheses
                // on touch devices (touch -> synthetic click). We use pointerdown
                // as the primary handler and ignore the following click if it
                // happened within a short time window.
                const handlePress = () => {
                    // When a letter is typed, respect shift/caps
                    let out = b.dataset.ch;
                    if (/[a-zA-Z]/.test(out)) {
                        const up = (capsLock && !shiftActive) || (!capsLock && shiftActive);
                        out = up ? out.toUpperCase() : out.toLowerCase();
                    }
                    kbAppend(out);
                    // reset shift if it was a one-off press
                    if (shiftActive && !capsLock) { shiftActive = false; refreshKeys(); }
                };
                b.addEventListener('pointerdown', (e) => { e.preventDefault(); handlePress(); b.__lastPointer = Date.now(); }, { passive:false });
                b.addEventListener('click', (e) => { if (Date.now() - (b.__lastPointer || 0) < 450) return; handlePress(); });
                row.appendChild(b);
            }
            return row;
        }

        function refreshKeys() {
            // rebuild the keys container according to symbolMode
            keysContainer.innerHTML = '';
            // numbers row is useful in both modes (can show 123.. or symbol variants)
            keysContainer.appendChild(buildRow(numberRow.split('')));
            if (!symbolMode) {
                for (const r of alphaRows) keysContainer.appendChild(buildRow(r.split('')));
            } else {
                for (const r of symbolRows) keysContainer.appendChild(buildRow(r.split('')));
            }
        }

        refreshKeys();

        // last row: space, backspace, enter
        const last = document.createElement('div'); last.style = 'display:flex; gap:8px; margin-top:10px; justify-content:center; align-items:center;';
        const shiftBtn = document.createElement('button'); shiftBtn.innerText = 'Shift'; shiftBtn.title = 'Shift'; shiftBtn.style = 'width:72px; height:44px; border-radius:10px; background:rgba(255,255,255,0.06); color:#fff; border:none; font-size:14px;';
        const capsBtn = document.createElement('button'); capsBtn.innerText = 'Caps'; capsBtn.title = 'Caps Lock'; capsBtn.style = 'width:64px; height:44px; border-radius:10px; background:rgba(255,255,255,0.03); color:#fff; border:none; font-size:14px;';
        const space = document.createElement('button'); space.innerText = 'Space'; space.style = 'flex:1; height:44px; border-radius:10px; background:rgba(255,255,255,0.06); color:#fff; border:none; font-size:16px;';
        const bk = document.createElement('button'); bk.innerText = '⌫'; bk.title = 'Backspace'; bk.style = 'width:56px; height:44px; border-radius:10px; background:rgba(255,255,255,0.06); color:#fff; border:none; font-size:18px;';
        const send = document.createElement('button'); send.innerText = 'Send'; send.title = 'Send (Enter)'; send.style = 'width:86px; height:44px; border-radius:10px; background:rgba(0,160,255,0.9); color:#fff; border:none; font-weight:700;';
        const symBtn = document.createElement('button'); symBtn.innerText = 'Sym'; symBtn.title = 'Symbols'; symBtn.style = 'width:64px; height:44px; border-radius:10px; background:rgba(255,255,255,0.03); color:#fff; border:none; font-size:14px;';
        last.appendChild(shiftBtn); last.appendChild(capsBtn); last.appendChild(space); last.appendChild(bk); last.appendChild(send); last.appendChild(symBtn);
        jsKb.appendChild(last);

        // attach keyboard to container so it overlays properly
        container.appendChild(jsKb);

        // keyboard helpers
        // Append a character to the on-screen keyboard buffer only.
        // Characters are NOT dispatched to the WASM engine until the
        // user explicitly presses the Send button. This prevents duplicate
        // / premature characters when using our JS keyboard on mobile.
        // Track how many characters we've already dispatched to the
        // engine in real-time, so we avoid resending them when the
        // user finally presses Send. This allows certain keys (e.g.,
        // backspace, space) to act immediately without duplication.
        let kbSentCount = 0;

        function kbAppend(ch) {
            // If this JS keyboard was opened but the in-game chat has not
            // yet been opened, synthesize a single 't' to open the chat
            // window before sending typed characters. This keeps the UI
            // quiet when the keyboard is opened and prevents multiple 't'
            // characters from being injected on open.
            if (jsKeyboardNeedsChatOpen) {
                try { sendLowercaseT(); } catch (e) {}
                jsKeyboardNeedsChatOpen = false;
            }
            kbText.innerText += ch;
            // mirror the visible JS keyboard text into the hidden input so
            // input handlers (if any) see the same text and state stays consistent.
            try { hiddenInput.value = kbText.innerText; hiddenInputPrevValue = hiddenInput.value; } catch (err) {}
            // For the space key, deliver it immediately to the engine so
            // users see the space in the chat UI in real-time. We count it
            // as already-sent (kbSentCount) so Send won't re-send it.
            if (ch === ' ' && jsKeyboardActive) {
                try { sendCharEvents(ch); kbSentCount++; } catch (e) {}
            }
            // Intentionally do NOT call sendCharEvents() for other keys
            // here — they'll be sent later when the user presses Send.
        }
        // Backspace only modifies the on-screen buffer; do not synthesize
        // backspace events until the final message is sent.
        function kbBackspace() {
            // If the JS keyboard was opened but chat hasn't been opened in
            // the engine yet, open it so the backspace takes effect in the
            // chat UI (and not only locally in the buffer).
            if (jsKeyboardNeedsChatOpen) {
                try { sendLowercaseT(); } catch (e) {}
                jsKeyboardNeedsChatOpen = false;
            }

            if (kbText.innerText.length > 0) {
                kbText.innerText = kbText.innerText.slice(0, -1);
                try { hiddenInput.value = kbText.innerText; hiddenInputPrevValue = hiddenInput.value; } catch (err) {}
                // Also send a real backspace event to the canvas so the
                // engine's chat box is updated immediately while typing.
                try { sendBackspace(); } catch (e) {}
                if (kbSentCount > 0) kbSentCount = Math.max(0, kbSentCount - 1);
            } else {
                // Buffer empty: still send a backspace so the engine's
                // input state can respond (some UI may have text already).
                try { sendBackspace(); } catch (e) {}
                if (kbSentCount > 0) kbSentCount = Math.max(0, kbSentCount - 1);
            }
        }
        function kbSend() {
            // When the user presses Send, dispatch the buffered characters
            // as synthetic key events to the canvas/engine, then press Enter
            // so that the chat gets submitted.
            const msg = kbText.innerText || '';
            // Only send the characters that haven't already been dispatched
            // in real-time (kbSentCount). This avoids duplicate characters
            // for keys like Space which we may have sent immediately.
            const startIndex = Math.min(Math.max(0, kbSentCount), msg.length);
            const unsent = msg.slice(startIndex);
            if (unsent.length > 0) {
                for (let i = 0; i < unsent.length; i++) {
                    const ch = unsent[i];
                    setTimeout(() => { try { sendCharEvents(ch); } catch (e) {} }, i * 18);
                }
            }
            // Schedule Enter after the unsent characters finish dispatching
            const enterDelay = Math.max(1, unsent.length * 18) + 30;
            // Dispatch a proper Enter key sequence (keydown -> keypress -> keyup)
            setTimeout(() => {
                try {
                    const kd = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
                    const kp = new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
                    const ku = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
                    canvas.dispatchEvent(kd);
                    canvas.dispatchEvent(kp);
                    // Slight delay before keyup to mimic real user press
                    setTimeout(() => { canvas.dispatchEvent(ku); }, 20);
                } catch (e) { }
            }, enterDelay);

            // hide keyboard and clear text after sending
            kbText.innerText = '';
            // reset sent counter (we've delivered everything)
            kbSentCount = 0;
            try { hiddenInput.value = ''; hiddenInputPrevValue = ''; } catch (err) {}
            shiftActive = false; refreshKeys();
            hideJSKeyboard();
        }
        // Use pointerdown for reliable touch response and prevent duplicate
        // synthetic click events that would call handlers twice.
        kbClear.addEventListener('pointerdown', (e) => { e.preventDefault(); kbText.innerText = ''; hiddenInput.value = ''; hiddenInputPrevValue = ''; kbClear.__lastPointer = Date.now(); }, { passive:false });
        kbClear.addEventListener('click', (e) => { if (Date.now() - (kbClear.__lastPointer || 0) < 450) return; kbText.innerText = ''; hiddenInput.value = ''; hiddenInputPrevValue = ''; });
        space.addEventListener('pointerdown', (e) => { e.preventDefault(); kbAppend(' '); space.__lastPointer = Date.now(); }, { passive:false });
        space.addEventListener('click', (e) => { if (Date.now() - (space.__lastPointer || 0) < 450) return; kbAppend(' '); });
        bk.addEventListener('pointerdown', (e) => { e.preventDefault(); kbBackspace(); bk.__lastPointer = Date.now(); }, { passive:false });
        bk.addEventListener('click', (e) => { if (Date.now() - (bk.__lastPointer || 0) < 450) return; kbBackspace(); });
        send.addEventListener('pointerdown', (e) => { e.preventDefault(); kbSend(); send.__lastPointer = Date.now(); }, { passive:false });
        send.addEventListener('click', (e) => { if (Date.now() - (send.__lastPointer || 0) < 450) return; kbSend(); });
        // shift / caps / symbols
        shiftBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); shiftActive = !shiftActive; shiftBtn.style.background = shiftActive ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)'; refreshKeys(); shiftBtn.__lastPointer = Date.now(); }, { passive:false });
        shiftBtn.addEventListener('click', (e) => { if (Date.now() - (shiftBtn.__lastPointer || 0) < 450) return; shiftActive = !shiftActive; shiftBtn.style.background = shiftActive ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)'; refreshKeys(); });
        capsBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); capsLock = !capsLock; capsBtn.style.background = capsLock ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.03)'; refreshKeys(); capsBtn.__lastPointer = Date.now(); }, { passive:false });
        capsBtn.addEventListener('click', (e) => { if (Date.now() - (capsBtn.__lastPointer || 0) < 450) return; capsLock = !capsLock; capsBtn.style.background = capsLock ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.03)'; refreshKeys(); });
        symBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); symbolMode = !symbolMode; symBtn.style.background = symbolMode ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.03)'; refreshKeys(); symBtn.__lastPointer = Date.now(); }, { passive:false });
        symBtn.addEventListener('click', (e) => { if (Date.now() - (symBtn.__lastPointer || 0) < 450) return; symbolMode = !symbolMode; symBtn.style.background = symbolMode ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.03)'; refreshKeys(); });

        // Show/hide helpers
        function showJSKeyboard(show) {
            if (show) {
                // if the hidden input is focused (native keyboard), blur it —
                // we're using our own JS keyboard now.
                try { hiddenInput.blur(); } catch (e) {}
                mobileKeyboardActive = false;
                jsKeyboardActive = true; jsKb.style.display = 'block';
            } else {
                jsKeyboardActive = false; jsKb.style.display = 'none';
            }
        }
        function hideJSKeyboard() { kbText.innerText = ''; try { hiddenInput.value = ''; hiddenInputPrevValue = ''; } catch (err) {} showJSKeyboard(false); }

        // When the game's chat is closed by the game itself, or ESC is used,
        // the UI should hide our keyboard as well. Hook the keyboard close
        // to the Escape key (which the game will call), and also allow the
        // menu button to hide it.
        menuBtn.addEventListener('click', (e) => { e.preventDefault(); sendEscapePress(); hideJSKeyboard(); });

    // place overlay inside the canvas container so it layers above the canvas
    container.style.position = 'relative';
    container.appendChild(overlay);

    // --- Debug HUD (visible while developing) ---
    const dbg = document.createElement('div');
    dbg.id = 'mc_debug';
    dbg.style = `position: absolute; left: 8px; top: 8px; z-index: 13000; pointer-events: none; color: #fff; background: rgba(0,0,0,0.45); padding:6px 8px; border-radius:6px; font-size:12px; max-width: 260px;`;
    dbg.innerText = 'Debug: initializing...';
    container.appendChild(dbg);
    let dbgInterval = setInterval(() => {
        try {
            if (!isiOS) {
            const cw = canvas.width || 0;
            const ch = canvas.height || 0;
            const csw = canvas.style ? (canvas.style.width || 'auto') : 'n/a';
            const csh = canvas.style ? (canvas.style.height || 'auto') : 'n/a';
            const fs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
            dbg.innerText = `Canvas: ${cw}x${ch}\nCSS: ${csw} x ${csh}\nFullscreen: ${fs}\nOverlay visible: ${overlay.style.display}`;
            }
        } catch (e) { dbg.innerText = 'Debug: error reading canvas'; }
    }, 500);

    // --- Input mapping helpers ---
    // Track simple key down state to avoid duplicate events. Add Escape
    // so UI buttons that synthesize 'Escape' behave correctly.
    const keyState = { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, Escape: false };
    // When the mobile keyboard is active (hidden input focused) avoid
    // calling canvas.focus(), which would steal focus and cause the
    // system keyboard to immediately close on many mobile browsers.
    // These are assigned to globals (declared earlier) so top-level
    // functions can safely consult keyboard state.
    mobileKeyboardActive = false;
    // When our JS on-screen keyboard is visible, avoid focusing the canvas
    // and route events via the JS keyboard.
    jsKeyboardActive = false;

    function sendKey(code, down) {
        // Avoid sending duplicate events
        if (keyState[code] === down) return;
        keyState[code] = down;

        // Provide broader event properties to maximize compatibility with older engines
        const keyName = (code === 'Space') ? ' ' : code.replace('Key', '');
        // Add commonly-used keyCodes so compiled engines that rely on keyCode/which
        // can also see these values. Inventory typically uses 'I' (73) or 'E' (69).
        // Include common legacy keyCode values so older engines detect keys like Escape (27).
        const keyCodeMap = { KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, Space: 32, KeyI: 73, KeyE: 69, Escape: 27 };
        const kc = keyCodeMap[code] || 0;

        // Focus the canvas first so SDl/wasm receives these events, but
        // do not steal focus while the mobile keyboard is active.
        try { if (!mobileKeyboardActive && !jsKeyboardActive) canvas.focus(); } catch (e) { }

        // Some environments expect keyCode/which to exist, also ensure events bubble
        let ev;
        try {
            ev = new KeyboardEvent(down ? 'keydown' : 'keyup', {
                code: code,
                key: keyName,
                keyCode: kc,
                which: kc,
                bubbles: true,
                cancelable: true
            });
        } catch (err) {
            // Fallback for older browsers that don't accept full args
            ev = document.createEvent('KeyboardEvent');
            // initKeyboardEvent differs across browsers; try best-effort
            try { ev.initKeyboardEvent(down ? 'keydown' : 'keyup', true, true, window, keyName, 0, '', false, ''); } catch (e) { /* ignore */ }
        }

        // Dispatch to multiple targets so the wasm/SDL input handlers catch them.
        canvas.dispatchEvent(ev);
        document.dispatchEvent(ev);
        window.dispatchEvent(ev);

        // No extra 'keypress' synthetic events here — keep sendKey strict so a caller
        // deciding to synthesize a press can do so explicitly. This ensures buttons
        // mapped to a specific code (like 'KeyI') only send that key event.
    }

    // Helper to send a short key press (keydown then keyup) and ensure canvas is focused.
    // Keep this for compatibility, but inventory will also support plain down/up mapping.
    function sendKeyPress(code) {
        // focus canvas so SDL/wasm accepts the key, but avoid stealing
        // focus from the mobile input when it's active.
        try { if (!mobileKeyboardActive && !jsKeyboardActive) canvas.focus(); } catch (e) {}
        // Try several forms (lower/upper, keypress) and a short sequence so the wasm engine accepts it.
        const tryPress = (c, keyChar) => {
            try { sendKey(c, true); } catch (e) {}
            try {
                const kp = new KeyboardEvent('keypress', { key: keyChar, code: c, keyCode: keyChar.charCodeAt(0), which: keyChar.charCodeAt(0), bubbles: true, cancelable: true });
                canvas.dispatchEvent(kp); document.dispatchEvent(kp); window.dispatchEvent(kp);
            } catch (err) {}
            // scheduled keyup
            setTimeout(() => { try { sendKey(c, false); } catch (e) {} }, 60);
        };

        const keyName = code.replace('Key', '');
        // attempt lowercase and uppercase variants shortly apart
        tryPress(code, keyName.toLowerCase());
        setTimeout(() => tryPress(code, keyName.toUpperCase()), 80);

        // Removed KeyE fallback — keep sendKeyPress focused on the requested code only
        // (attempted lowercase + uppercase variants above).
    }

    // Fullscreen control moved to a manual toggle button. We no longer auto-request
    // fullscreen on the first touch — users can explicitly toggle fullscreen via the
    // top-right button introduced below.

    function sendMouse(type, clientX, clientY, button=0, movementX=0, movementY=0) {
        // Create MouseEvent; browsers may not honor movementX/movementY in constructor, so include client coords
        const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button });
        canvas.dispatchEvent(ev);
        document.dispatchEvent(ev);
    }

    // --- Left joystick logic (WASD) ---
    let leftTouchId = null;
    let leftCenter = { x: 0, y: 0 };
    let leftRadius = 0;

    leftPad.addEventListener('touchstart', (e) => {
        e.preventDefault();
        // don't auto-request fullscreen on touch; user may use the fullscreen toggle
        const t = e.changedTouches[0];
        leftTouchId = t.identifier;
        const rect = leftPad.getBoundingClientRect();
        leftCenter = { x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
        leftRadius = Math.min(rect.width, rect.height)/2;
        updateLeftThumb(t.clientX, t.clientY);
    }, { passive: false });

    leftPad.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (const t of Array.from(e.changedTouches)) {
            if (t.identifier !== leftTouchId) continue;
            updateLeftThumb(t.clientX, t.clientY);
        }
    }, { passive: false });

    leftPad.addEventListener('touchend', (e) => {
        for (const t of Array.from(e.changedTouches)) {
            if (t.identifier !== leftTouchId) continue;
            leftTouchId = null;
            leftThumb.style.transform = 'translate(0px,0px)';
            // release all movement keys
            sendKey('KeyW', false);
            sendKey('KeyA', false);
            sendKey('KeyS', false);
            sendKey('KeyD', false);
        }
    }, { passive: false });

    // Ensure touchcancel also releases movement so states don't stick
    leftPad.addEventListener('touchcancel', (e) => {
        leftTouchId = null;
        leftThumb.style.transform = 'translate(0px,0px)';
        sendKey('KeyW', false);
        sendKey('KeyA', false);
        sendKey('KeyS', false);
        sendKey('KeyD', false);
    }, { passive: false });

    function updateLeftThumb(cx, cy) {
        const dx = cx - leftCenter.x;
        const dy = cy - leftCenter.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        const max = leftRadius * 0.6;
        const nx = Math.max(-1, Math.min(1, dx / max));
        const ny = Math.max(-1, Math.min(1, dy / max));
        const tx = nx * max * 0.6; // visual
        const ty = ny * max * 0.6;
        leftThumb.style.transform = `translate(${tx}px, ${ty}px)`;

        // Simple 4-direction mapping with diagonal support
        // Use a slightly lower threshold for responsiveness on smaller movements
        const TH = 0.22;
        const up = ny < -TH;
        const down = ny > TH;
        const left = nx < -TH;
        const right = nx > TH;

        sendKey('KeyW', up);
        sendKey('KeyS', down);
        sendKey('KeyA', left);
        sendKey('KeyD', right);
    }

    // --- Buttons: Jump, Primary (left click), Secondary (right click) ---
    function makeButtonTouchHandlers(btn, onDown, onUp) {
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); onDown(); }, { passive:false });
        btn.addEventListener('touchend', (e) => { e.preventDefault(); onUp(); }, { passive:false });
        btn.addEventListener('touchcancel', (e) => { e.preventDefault(); onUp(); }, { passive:false });
        // mouse fallback for desktop testing
        btn.addEventListener('mousedown', (e) => { e.preventDefault(); onDown(); });
        btn.addEventListener('mouseup', (e) => { e.preventDefault(); onUp(); });
    }

    // Jump only toggles Space; Use simulates a right-click (button=2)
    makeButtonTouchHandlers(btnJump, () => sendKey('Space', true), () => sendKey('Space', false));
    makeButtonTouchHandlers(btnUse, () => sendMouse('mousedown', canvas.clientWidth/2, canvas.clientHeight/2, 2), () => sendMouse('mouseup', canvas.clientWidth/2, canvas.clientHeight/2, 2));

    // Inventory toggles 'I' key — use the same down/up mapping as other controls
    // Inventory often expects the printable lowercase 'i' character.
    // Send a focused sequence: keydown (code=KeyI, key='i'), keypress (char 'i'), then keyup.
    function sendLowercaseI() {
        try { if (!mobileKeyboardActive && !jsKeyboardActive) canvas.focus(); } catch (e) {}
        const code = 'KeyI';
        const keyChar = 'i';
        const keyDownCode = 73; // keyCode for 'I' physical key
        const charCode = keyChar.charCodeAt(0); // 105 for 'i'

        // keydown with lowercase key
        try {
            const ev = new KeyboardEvent('keydown', { code: code, key: keyChar, keyCode: keyDownCode, which: keyDownCode, bubbles: true, cancelable: true });
            canvas.dispatchEvent(ev); document.dispatchEvent(ev); window.dispatchEvent(ev);
        } catch (err) {}

        // keypress for printable lowercase char
        try {
            const kp = new KeyboardEvent('keypress', { key: keyChar, code: code, keyCode: charCode, which: charCode, charCode: charCode, bubbles: true, cancelable: true });
            canvas.dispatchEvent(kp); document.dispatchEvent(kp); window.dispatchEvent(kp);
        } catch (err) {}

        // keyup
        setTimeout(() => {
            try {
                const ev2 = new KeyboardEvent('keyup', { code: code, key: keyChar, keyCode: keyDownCode, which: keyDownCode, bubbles: true, cancelable: true });
                canvas.dispatchEvent(ev2); document.dispatchEvent(ev2); window.dispatchEvent(ev2);
            } catch (err) {}
        }, 60);
    }

    makeButtonTouchHandlers(btnInv, () => sendLowercaseI(), () => {});

    // Send wheel event for hotbar change. deltaY negative -> scroll up (previous), positive -> scroll down (next)
    function sendWheel(deltaY) {
        const rect = canvas.getBoundingClientRect();
        const cx = Math.round(rect.left + rect.width/2);
        const cy = Math.round(rect.top + rect.height/2);
        let ev;
        try {
            ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: deltaY, clientX: cx, clientY: cy });
        } catch (err) {
            // older browsers may not allow constructor options, fall back
            ev = document.createEvent('Event');
            ev.initEvent('wheel', true, true);
            ev.deltaY = deltaY;
            ev.clientX = cx;
            ev.clientY = cy;
        }
        canvas.dispatchEvent(ev);
        document.dispatchEvent(ev);
    }

    makeButtonTouchHandlers(hbLeft, () => sendWheel(-120), () => {});
    makeButtonTouchHandlers(hbRight, () => sendWheel(120), () => {});

    // --- Right pad: look / mouse movement simulation ---
    let rightTouchId = null;
    let lastPos = null;

    rightPad.addEventListener('touchstart', (e) => {
        e.preventDefault();
        // intentionally avoid auto-fullscreen here; use the explicit control button
        const t = e.changedTouches[0];
        rightTouchId = t.identifier;
        lastPos = { x: t.clientX, y: t.clientY };
        // Try to request pointerlock, but only when the runtime indicates
        // it wants pointer lock or when the browser supports it. This avoids
        // noisy console errors when the request isn't supported or when
        // the runtime isn't ready to handle pointerlock requests.
        try {
            // If the engine has exposed a 'want pointerlock' check, prefer
            // that so the runtime can opt into pointer lock behaviour.
            if (typeof irrlicht_want_pointerlock === 'function') {
                try {
                    if (irrlicht_want_pointerlock()) {
                        if (typeof irrlicht_force_pointerlock === 'function') {
                            irrlicht_force_pointerlock();
                        } else if (canvas.requestPointerLock) {
                            canvas.requestPointerLock();
                        }
                    }
                } catch (err) { /* ignore */ }
            } else if (canvas.requestPointerLock) {
                // Fallback: request pointerlock directly if available.
                try { canvas.requestPointerLock(); } catch (err) { /* ignore */ }
            }
        } catch (e) {}
    }, { passive:false });

    rightPad.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (const t of Array.from(e.changedTouches)) {
            if (t.identifier !== rightTouchId) continue;
            const dx = t.clientX - lastPos.x;
            const dy = t.clientY - lastPos.y;
            lastPos = { x: t.clientX, y: t.clientY };
            // Send small mousemove events so WASM receives movement
            sendMouse('mousemove', t.clientX, t.clientY, 0, dx, dy);
        }
    }, { passive:false });

    rightPad.addEventListener('touchend', (e) => {
        for (const t of Array.from(e.changedTouches)) {
            if (t.identifier !== rightTouchId) continue;
            rightTouchId = null;
            lastPos = null;
        }
    }, { passive:false });

    rightPad.addEventListener('touchcancel', (e) => {
        rightTouchId = null;
        lastPos = null;
    }, { passive:false });

    // Small helper to show for short-screen devices: enable overlay controls for small widths
    function adjustOverlayVisibility() {
        if (window.innerWidth < 900 || isTouch) {
            overlay.style.display = 'flex';
        } else {
            overlay.style.display = 'none';
        }
    }

    window.addEventListener('resize', adjustOverlayVisibility);
    adjustOverlayVisibility();

    // --- Fullscreen toggle button (explicit control) ---
    // create a small toggle in the top-right corner so users can persistently
    // enter fullscreen and exit explicitly.
    const fsBtn = document.createElement('button');
    fsBtn.id = 'mc_fullscreen';
    fsBtn.title = 'Toggle fullscreen';
    fsBtn.innerText = '⤢';
    // Place the fullscreen toggle beside the hotbar controls so it's easy
    // to access while in-game. Use the existing button visual style so it
    // matches the other action buttons.
    fsBtn.style = btnStyle + ' width:48px; height:48px; font-size:18px; margin-left:6px;';
    // Attach the fullscreen button into the main buttons cluster so it
    // appears next to the hotbar left/right arrows.
    buttons.appendChild(fsBtn);

    let _manualFullscreenToggled = false;
    function setFullscreenUI(on) {
        _manualFullscreenToggled = !!on;
        // visual state: filled vs outline, simple text change
        fsBtn.innerText = on ? '⤡' : '⤢';
    }

    async function toggleFullscreen() {
        try {
            if (!_manualFullscreenToggled) {
                if (container.requestFullscreen) await container.requestFullscreen();
                else if (container.webkitRequestFullscreen) await container.webkitRequestFullscreen();
                else if (container.mozRequestFullScreen) await container.mozRequestFullScreen();
                else if (container.msRequestFullscreen) await container.msRequestFullscreen();
                setFullscreenUI(true);
            } else {
                if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement) {
                    try { await document.exitFullscreen?.(); } catch(e) { try { document.webkitExitFullscreen?.(); } catch(e) {} }
                }
                setFullscreenUI(false);
            }
        } catch (err) {
            // ignore fullscreen errors
        }
    }

    fsBtn.addEventListener('click', (e) => { e.preventDefault(); toggleFullscreen(); });

    // Keep UI in-sync if the browser exits fullscreen by other means (ESC/etc.)
    const onFullScreenChange = () => {
        const active = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
        setFullscreenUI(active);
        // Ensure the canvas is re-computed and scaled appropriately when
        // the browser enters/exits fullscreen. On small mobile screens the
        // native canvas size can be larger than the physical screen — in
        // that case we want to apply a CSS scale so in-game UI (inventory)
        // fits inside the device viewport.
        try { fixGeometry(true); } catch (e) { /* best-effort */ }
    };
    document.addEventListener('fullscreenchange', onFullScreenChange);
    document.addEventListener('webkitfullscreenchange', onFullScreenChange);
    document.addEventListener('mozfullscreenchange', onFullScreenChange);
    document.addEventListener('MSFullscreenChange', onFullScreenChange);

    // --- Scroll down helper (for tall UI like inventory) ---
    // A button near the fullscreen toggle that, when pressed/held, repeatedly
    // sends wheel events to the canvas so users can scroll tall in-game panels.
    const scrollDownBtn = document.createElement('button');
    scrollDownBtn.id = 'mc_scroll_down';
    scrollDownBtn.title = 'Scroll down';
    scrollDownBtn.innerText = '↓';
    scrollDownBtn.style = `
        position: absolute; right: 12px; top: 56px; z-index: 11000; pointer-events: auto;
        padding: 8px 10px; border-radius: 10px; background: rgba(0,0,0,0.22); color: #fff;
        font-weight:700; border: none; box-shadow: 0 6px 18px rgba(0,0,0,0.4);
    `;
    container.appendChild(scrollDownBtn);

    // When held, repeatedly call sendWheel with a positive deltaY. Single tap does one scroll.
    let _scrollHoldInterval = null;
    function startScrollDown() {
        // first immediate scroll for responsiveness
        try { sendWheel(240); } catch (e) {}
        if (_scrollHoldInterval) return;
        _scrollHoldInterval = setInterval(() => { try { sendWheel(240); } catch (e) {} }, 90);
    }
    function stopScrollDown() {
        if (_scrollHoldInterval) { clearInterval(_scrollHoldInterval); _scrollHoldInterval = null; }
    }

    // touch handlers
    scrollDownBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startScrollDown(); }, { passive:false });
    scrollDownBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopScrollDown(); }, { passive:false });
    scrollDownBtn.addEventListener('touchcancel', (e) => { e.preventDefault(); stopScrollDown(); }, { passive:false });
    // mouse click/hold fallback for desktop testing
    scrollDownBtn.addEventListener('mousedown', (e) => { e.preventDefault(); startScrollDown(); });
    scrollDownBtn.addEventListener('mouseup', (e) => { e.preventDefault(); stopScrollDown(); });
}

var PB_bytes_downloaded = 0;
var PB_bytes_needed = 0;
function updateProgressBar(doneBytes, neededBytes) {
    PB_bytes_downloaded += doneBytes;
    PB_bytes_needed += neededBytes;
    if (progressBar) {
        progressBarDiv.style.display = (PB_bytes_downloaded == PB_bytes_needed) ? "none" : "block";
        const pct = PB_bytes_needed ? Math.round(100 * PB_bytes_downloaded / PB_bytes_needed) : 0;
        progressBar.value = `${pct}`;
        progressBar.innerText = `${pct}%`;
    }
}

// Singleton
var mtLauncher = null;

class LaunchScheduler {
    constructor() {
        this.conditions = new Map();
        window.requestAnimationFrame(this.invokeCallbacks.bind(this));
    }

    isSet(name) {
        return this.conditions.get(name)[0];
    }

    addCondition(name, startCallback = null, deps = []) {
        this.conditions.set(name, [false, new Set(), startCallback]);
        for (const depname of deps) {
            this.addDep(name, depname);
        }
    }

    addDep(name, depname) {
        if (!this.isSet(depname)) {
            this.conditions.get(name)[1].add(depname);
        }
    }

    setCondition(name) {
        if (this.isSet(name)) {
            throw new Error('Scheduler condition set twice');
        }
        this.conditions.get(name)[0] = true;
        this.conditions.forEach(v => {
            v[1].delete(name);
        });
        window.requestAnimationFrame(this.invokeCallbacks.bind(this));
    }

    clearCondition(name, newCallback = null, deps = []) {
        if (!this.isSet(name)) {
            throw new Error('clearCondition called on unset condition');
        }
        const arr = this.conditions.get(name);
        arr[0] = false;
        arr[1] = new Set(deps);
        arr[2] = newCallback;
    }

    invokeCallbacks() {
        const callbacks = [];
        this.conditions.forEach(v => {
            if (!v[0] && v[1].size == 0 && v[2] !== null) {
                callbacks.push(v[2]);
                v[2] = null;
            }
        });
        callbacks.forEach(cb => cb());
    }
}
const mtScheduler = new LaunchScheduler();

function loadWasm() {
    // Start loading the wasm module
    // The module will call emloop_ready when it is loaded
    // and waiting for main() arguments.
    const mtModuleScript = document.createElement("script");
    mtModuleScript.type = "text/javascript";
    mtModuleScript.src = RELEASE_DIR + "/minetest.js";
    mtModuleScript.async = true;
    document.head.appendChild(mtModuleScript);
}

function callMain() {
    const fullargs = [ './minetest', ...mtLauncher.args.toArray() ];
    const [argc, argv] = makeArgv(fullargs);
    emloop_invoke_main(argc, argv);
    // Pausing and unpausing here gives the browser time to redraw the DOM
    // before Minetest freezes the main thread generating the world. If this
    // is not done, the page will stay frozen for several seconds
    emloop_request_animation_frame();
    mtScheduler.setCondition("main_called");
}

var emloop_pause;
var emloop_unpause;
var emloop_init_sound;
var emloop_invoke_main;
var emloop_install_pack;
var emloop_set_minetest_conf;
var irrlicht_want_pointerlock;
var irrlicht_force_pointerlock;
var irrlicht_resize;
var emsocket_init;
var emsocket_set_proxy;
var emsocket_set_vpn;

// Called when the wasm module is ready
function emloop_ready() {
    emloop_pause = cwrap("emloop_pause", null, []);
    emloop_unpause = cwrap("emloop_unpause", null, []);
    emloop_init_sound = cwrap("emloop_init_sound", null, []);
    emloop_invoke_main = cwrap("emloop_invoke_main", null, ["number", "number"]);
    emloop_install_pack = cwrap("emloop_install_pack", null, ["number", "number", "number"]);
    emloop_set_minetest_conf = cwrap("emloop_set_minetest_conf", null, ["number"]);
    irrlicht_want_pointerlock = cwrap("irrlicht_want_pointerlock", "number");
    irrlicht_force_pointerlock = cwrap("irrlicht_force_pointerlock", null);
    irrlicht_resize = cwrap("irrlicht_resize", null, ["number", "number"]);
    emsocket_init = cwrap("emsocket_init", null, []);
    emsocket_set_proxy = cwrap("emsocket_set_proxy", null, ["number"]);
    emsocket_set_vpn = cwrap("emsocket_set_vpn", null, ["number"]);
    mtScheduler.setCondition("wasmReady");
}

// Called when the wasm module wants to force redraw before next frame
function emloop_request_animation_frame() {
    emloop_pause();
    window.requestAnimationFrame(() => { emloop_unpause(); });
}

function makeArgv(args) {
    // Assuming 4-byte pointers
    const argv = _malloc((args.length + 1) * 4);
    let i;
    for (i = 0; i < args.length; i++) {
        HEAPU32[(argv >>> 2) + i] = stringToNewUTF8(args[i]);
    }
    HEAPU32[(argv >>> 2) + i] = 0; // argv[argc] == NULL
    return [i, argv];
}

var consoleText = [];
var consoleLengthMax = 1000;
var consoleTextLast = 0;
var consoleDirty = false;
function consoleUpdate() {
    if (consoleDirty) {
        if (consoleText.length > consoleLengthMax) {
            consoleText = consoleText.slice(-consoleLengthMax);
        }
        consoleOutput.value = consoleText.join('');
        consoleOutput.scrollTop = consoleOutput.scrollHeight; // focus on bottom
        consoleDirty = false;
    }
    window.requestAnimationFrame(consoleUpdate);
}

function consoleToggle() {
    consoleOutput.style.display = (consoleOutput.style.display == 'block') ? 'none' : 'block';
    consoleButton.value = (consoleOutput.style.display == 'none') ? 'Show Console' : 'Hide Console';
    fixGeometry();
}

var enableTracing = false;
function consolePrint(text) {
    if (enableTracing) {
        console.trace(text);
    }
    consoleText.push(text + "\n");
    consoleDirty = true;
    if (mtLauncher && mtLauncher.onprint) {
        mtLauncher.onprint(text);
    }
}

var Module = {
    preRun: [],
    postRun: [],
    print: consolePrint,
    canvas: (function() {
        // As a default initial behavior, pop up an alert when webgl context is lost. To make your
        // application robust, you may want to override this behavior before shipping!
        // See http://www.khronos.org/registry/webgl/specs/latest/1.0/#5.15.2
        mtCanvas.addEventListener("webglcontextlost", function(e) { alert('WebGL context lost. You will need to reload the page.'); e.preventDefault(); }, false);

        return mtCanvas;
    })(),
    setStatus: function(text) {
        if (text) Module.print('[wasm module status] ' + text);
    },
    totalDependencies: 0,
    monitorRunDependencies: function(left) {
        this.totalDependencies = Math.max(this.totalDependencies, left);
        if (!mtLauncher || !mtLauncher.onprogress) return;
        mtLauncher.onprogress('wasm_module', (this.totalDependencies-left) / this.totalDependencies);
    }
};

Module['printErr'] = Module['print'];

// This is injected into workers so that out/err are sent to the main thread.
// This probably should be the default behavior, but doesn't seem to be for WasmFS.
const workerInject = `
  Module['print'] = (text) => {
    postMessage({cmd: 'callHandler', handler: 'print', args: [text], threadId: Module['_pthread_self']()});
  };
  Module['printErr'] = (text) => {
    postMessage({cmd: 'callHandler', handler: 'printErr', args: [text], threadId: Module['_pthread_self']()});
  };
  importScripts('minetest.js');
`;
Module['mainScriptUrlOrBlob'] = new Blob([workerInject], { type: "text/javascript" });



Module['onFullScreen'] = () => { fixGeometry(); };
window.onerror = function(event) {
    consolePrint('Exception thrown, see JavaScript console');
};

function resizeCanvas(width, height) {
    const canvas = mtCanvas;
    if (canvas.width != width || canvas.height != height) {
        canvas.width = width;
        canvas.height = height;
        canvas.widthNative = width;
        canvas.heightNative = height;
    }
    // Trigger SDL window resize.
    // This should happen automatically, not sure why it doesn't.
    irrlicht_resize(width, height);
}

function now() {
    return (new Date()).getTime();
}

// Only allow fixGeometry to be called every 250ms
// Firefox calls this way too often, causing flicker.
var fixGeometryPause = 0;
function fixGeometry(override) {
    if (!override && now() < fixGeometryPause) {
        return;
    }
    const resolutionSelect = document.getElementById('resolution');
    const aspectRatioSelect = document.getElementById('aspectRatio');
    var canvas = mtCanvas;
    var resolution = resolutionSelect.value;
    var aspectRatio = aspectRatioSelect.value;
    var screenX;
    var screenY;

    // Prevent the controls from getting focus — but if the mobile chat input
    // is focused or our JS/native keyboard is visible, don't steal focus
    // (this would hide the OS keyboard or our UI).
    if (!(document.activeElement && document.activeElement.id === 'mc_text_input') && !mobileKeyboardActive && !jsKeyboardActive) {
        canvas.focus();
    }

    var isFullScreen = document.fullscreenElement ? true : false;
    if (isFullScreen) {
        screenX = screen.width;
        screenY = screen.height;
    } else {
        // F11-style full screen
        var controls = document.getElementById('controls');
        var maximized = !window.screenTop && !window.screenY;
        controls.style = maximized ? 'display: none' : '';

        var headerHeight = document.getElementById('header').offsetHeight;
        var footerHeight = document.getElementById('footer').offsetHeight;
        screenX = document.documentElement.clientWidth - 6;
        screenY = document.documentElement.clientHeight - headerHeight - footerHeight - 6;
    }

    // Size of the viewport (after scaling)
    var realX;
    var realY;
    if (aspectRatio == 'any') {
        realX = screenX;
        realY = screenY;
    } else {
        var ar = aspectRatio.split(':');
        var innerRatio = parseInt(ar[0]) / parseInt(ar[1]);
        var outerRatio = screenX / screenY;
        if (innerRatio <= outerRatio) {
            realX = Math.floor(innerRatio * screenY);
            realY = screenY;
        } else {
            realX = screenX;
            realY = Math.floor(screenX / innerRatio);
        }
    }

    // Native canvas resolution
    var resX;
    var resY;
    var scale = false;
    if (resolution == 'high') {
        resX = realX;
        resY = realY;
    } else if (resolution == 'medium') {
        resX = Math.floor(realX / 1.5);
        resY = Math.floor(realY / 1.5);
        scale = true;
    } else {
        resX = Math.floor(realX / 2.0);
        resY = Math.floor(realY / 2.0);
        scale = true;
    }
    // If fullscreen on a phone, some engines perform better with a fixed
    // canvas resolution. Force the native canvas resolution to 1194x485
    // when fullscreen on mobile devices (best-effort detection via UA / touch).
    const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
    const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '');
    if (isFullScreen && isTouchDevice && isMobileUA) {
        // Force the desired native resolution
        resX = 1194;
        resY = 485;
    }

    // When NOT fullscreened, use a fixed native canvas resolution so the
    // visible viewport / UI layout is predictable across devices.
    // User-requested: set the canvas to 1194x495 when not fullscreened.
    // When NOT fullscreened, use a fixed native canvas resolution so the
    // visible viewport / UI layout is predictable across devices. Only
    // apply this fixed size for mobile/touch devices (user requested).
    if (!isFullScreen && isTouchDevice && isMobileUA) {
        resX = 1194;
        resY = 495;
    }

    resizeCanvas(resX, resY);

    // Decide whether to set CSS width/height to scale the canvas on-screen.
    // Normally we only set CSS when the resolution select chose a scaled
    // mode (medium/low). But when fullscreen is active on small devices the
    // native canvas can be larger than the physical screen and needs to be
    // scaled down so the player can see UI overlays (inventory windows).
    let shouldSetStyle = !!scale;
    // If fullscreen and the native canvas is larger than the device screen,
    // force CSS scaling so the canvas fits inside the viewport.
    if (isFullScreen && (resX > screenX || resY > screenY)) {
        shouldSetStyle = true;
    }

    if (shouldSetStyle) {
        let styleW = realX;
        let styleH = realY;
        if (isFullScreen) {
            // Scale down to fit the physical screen while preserving aspect.
            const factor = Math.min(1.0, screenX / realX, screenY / realY);
            styleW = Math.max(1, Math.round(realX * factor));
            styleH = Math.max(1, Math.round(realY * factor));
        }
        canvas.style.setProperty("width", styleW + "px", "important");
        canvas.style.setProperty("height", styleH + "px", "important");
    } else {
        canvas.style.removeProperty("width");
        canvas.style.removeProperty("height");
    }
}

function setupResizeHandlers() {
    window.addEventListener('resize', () => { fixGeometry(); });

    // Needed to prevent special keys from triggering browser actions, like
    // F5 causing page reload.
    document.addEventListener('keydown', (e) => {
        // Allow F11 to go full screen
        if (e.code == "F11") {
            // On Firefox, F11 is animated. The window smoothly grows to
            // full screen over several seconds. During this transition, the 'resize'
            // event is triggered hundreds of times. To prevent flickering, have
            // fixGeometry ignore repeated calls, and instead resize every 500ms
            // for 2.5 seconds. By then it should be finished.
            fixGeometryPause = now() + 2000;
            for (var delay = 100; delay <= 2600; delay += 500) {
                setTimeout(() => { fixGeometry(true); }, delay);
            }
        }
    });
}

class MinetestArgs {
    constructor() {
        this.go = false;
        this.server = false;
        this.name = '';
        this.password = '';
        this.gameid = '';
        this.address = '';
        this.port = '';
        this.packs = [];
        this.extra = [];
    }

    toArray() {
        const args = [];
        if (this.go) args.push('--go');
        if (this.server) args.push('--server');
        if (this.name) args.push('--name', this.name);
        if (this.password) args.push('--password', this.password);
        if (this.gameid) args.push('--gameid', this.gameid);
        if (this.address) args.push('--address', this.address);
        if (this.port) args.push('--port', this.port.toString());
        args.push(...this.extra);
        return args;
    }

    toQueryString() {
        const params = new URLSearchParams();
        if (this.go) params.append('go', '');
        if (this.server) params.append('server', '');
        if (this.name) params.append('name', this.name);
        if (this.password) params.append('password', this.password);
        if (this.gameid) params.append('gameid', this.gameid);
        if (this.address) params.append('address', this.address);
        if (this.port) params.append('port', this.port.toString());
        const extra_packs = [];
        this.packs.forEach(v => {
            if (v != 'base' && v != 'minetest_game' && v != 'devtest' && v != this.gameid) {
                extra_packs.push(v);
            }
        });
        if (extra_packs.length) {
            params.append('packs', extra_packs.join(','));
        }
        if (this.extra.length) {
            params.append('extra', this.extra.join(','));
        }
        return params.toString();
    }

    static fromQueryString(qs) {
        const r = new MinetestArgs();
        const params = new URLSearchParams(qs);
        if (params.has('go')) r.go = true;
        if (params.has('server')) r.server = true;
        if (params.has('name')) r.name = params.get('name');
        if (params.has('password')) r.password = params.get('password');
        if (params.has('gameid')) r.gameid = params.get('gameid');
        if (params.has('address')) r.address = params.get('address');
        if (params.has('port')) r.port = parseInt(params.get('port'));
        if (r.gameid && r.gameid != 'minetest_game' && r.gameid != 'devtest' && r.gameid != 'base') {
            r.packs.push(r.gameid);
        }
        if (params.has('packs')) {
            params.get('packs').split(',').forEach(p => {
                if (!r.packs.includes(p)) {
                    r.packs.push(p);
                }
            });
        }
        if (params.has('extra')) {
            r.extra = params.get('extra').split(',');
        }
        return r;
    }
}

class MinetestLauncher {
    constructor() {
        if (mtLauncher !== null) {
            throw new Error("There can be only one launcher");
        }
        mtLauncher = this;
        this.args = null;
        this.onprogress = null; // function(name, percent done)
        this.onready = null; // function()
        this.onerror = null; // function(message)
        this.onprint = null; // function(text)
        this.addedPacks = new Set();
        this.vpn = null;
        this.serverCode = null;
        this.clientCode = null;
        this.proxyUrl = "wss://bc3d.etherdeck.org/proxy";
        this.packsDir = DEFAULT_PACKS_DIR;
        this.packsDirIsCors = false;
        this.minetestConf = new Map();

        mtScheduler.addCondition("wasmReady", loadWasm);
        mtScheduler.addCondition("launch_called");
        mtScheduler.addCondition("ready", this.#notifyReady.bind(this), ['wasmReady']);
        mtScheduler.addCondition("main_called", callMain, ['ready', 'launch_called']);
        this.addPack('base');
    }

    setProxy(url) {
        this.proxyUrl = url;
    }

    /*
     * Set the url for the pack files directory
     * This can be relative or absolute.
     */
    setPacksDir(url, is_cors) {
        this.packsDir = url;
        this.packsDirIsCors = is_cors;
    }

    #notifyReady() {
        mtScheduler.setCondition("ready");
        if (this.onready) this.onready();
    }

    isReady() {
        return mtScheduler.isSet("ready");
    }

    // Must be set before launch()
    setVPN(serverCode, clientCode) {
        this.serverCode = serverCode;
        this.clientCode = clientCode;
        this.vpn = serverCode ? serverCode : clientCode;
    }

    // Set a key/value pair in minetest.conf
    // Overrides previous values of the same key
    setConf(key, value) {
        key = key.toString();
        value = value.toString();
        this.minetestConf.set(key, value);
    }

    #renderMinetestConf() {
        let lines = [];
        for (const [k, v] of this.minetestConf.entries()) {
            lines.push(`${k} = ${v}\n`);
        }
        return lines.join('');
    }

    setLang(lang) {
        if (!SUPPORTED_LANGUAGES_MAP.has(lang)) {
            alert(`Invalid code in setLang: ${lang}`);
        }
        this.setConf("language", lang);
    }

    // Returns pack status:
    //   0 - pack has not been added
    //   1 - pack is downloading
    //   2 - pack has been installed
    checkPack(name) {
       if (!this.addedPacks.has(name)) {
           return 0;
       }
       if (mtScheduler.isSet("installed:" + name)) {
           return 2;
       }
       return 1;
    }

    addPacks(packs) {
        for (const pack of packs) {
            this.addPack(pack);
        }
    }

    async addPack(name) {
        if (mtScheduler.isSet("launch_called")) {
            throw new Error("Cannot add packs after launch");
        }
        if (name == 'minetest_game' || name == 'devtest' || this.addedPacks.has(name))
            return;
        this.addedPacks.add(name);

        const fetchedCond = "fetched:" + name;
        const installedCond = "installed:" + name;

        let chunks = [];
        let received = 0;
        // This is done here instead of at the bottom, because it needs to
        // be delayed until after the 'wasmReady' condition.
        // TODO: Add the ability to `await` a condition instead.
        const installPack = () => {
            // Install
            const data = _malloc(received);
            let offset = 0;
            for (const arr of chunks) {
                HEAPU8.set(arr, data + offset);
                offset += arr.byteLength;
            }
            emloop_install_pack(stringToNewUTF8(name), data, received);
            _free(data);
            mtScheduler.setCondition(installedCond);
            if (this.onprogress) {
                this.onprogress(`download:${name}`, 1.0);
                this.onprogress(`install:${name}`, 1.0);
            }
        };
        mtScheduler.addCondition(fetchedCond, null);
        mtScheduler.addCondition(installedCond, installPack, ["wasmReady", fetchedCond]);
        mtScheduler.addDep("main_called", installedCond);

        const packUrl = this.packsDir + '/' + name + '.pack';
        let resp;
        try {
            resp = await fetch(packUrl, this.packsDirIsCors ? { credentials: 'omit' } : {});
        } catch (err) {
            if (this.onerror) {
                this.onerror(`${err}`);
            } else {
                alert(`Error while loading ${packUrl}. Please refresh page`);
            }
            throw new Error(`${err}`);
        }
        // This could be null if the header is missing
        var contentLength = resp.headers.get('Content-Length');
        if (contentLength) {
            contentLength = parseInt(contentLength);
            updateProgressBar(0, contentLength);
        }
        let reader = resp.body.getReader();
        while (true) {
            const {done, value} = await reader.read();
            if (done) {
                break;
            }
            chunks.push(value);
            received += value.byteLength;
            if (contentLength) {
                updateProgressBar(value.byteLength, 0);
                if (this.onprogress) {
                    this.onprogress(`download:${name}`, received / contentLength);
                }
            }
        }
        mtScheduler.setCondition(fetchedCond);
    }

    // Launch minetest.exe <args>
    //
    // This must be called from a keyboard or mouse event handler,
    // after the 'onready' event has fired. (For this reason, it cannot
    // be called from the `onready` handler)
    launch(args) {
        if (!this.isReady()) {
            throw new Error("launch called before onready");
        }
        if (!(args instanceof MinetestArgs)) {
            throw new Error("launch called without MinetestArgs");
        }
        if (mtScheduler.isSet("launch_called")) {
            throw new Error("launch called twice");
        }
        this.args = args;
        if (this.args.gameid) {
            this.addPack(this.args.gameid);
        }
        this.addPacks(this.args.packs);
        activateBody();
        fixGeometry();
        if (this.minetestConf.size > 0) {
            const contents = this.#renderMinetestConf();
            console.log("minetest.conf is: ", contents);
            const confBuf = stringToNewUTF8(contents);
            emloop_set_minetest_conf(confBuf);
            _free(confBuf);
        }
        emloop_init_sound();
        // Setup emsocket
        // TODO: emsocket should export the helpers for this
        emsocket_init();
        const proxyBuf = stringToNewUTF8(this.proxyUrl);
        emsocket_set_proxy(proxyBuf);
        _free(proxyBuf);
        if (this.vpn) {
            const vpnBuf = stringToNewUTF8(this.vpn);
            emsocket_set_vpn(vpnBuf);
            _free(vpnBuf);
        }
        if (args.go) {
            // Prefer the runtime's pointerlock helper if available; otherwise
            // fall back to a direct request on the canvas (guarded).
            if (typeof irrlicht_force_pointerlock === 'function') {
                try { irrlicht_force_pointerlock(); } catch (e) { /* ignore */ }
            } else if (mtCanvas.requestPointerLock) {
                try { mtCanvas.requestPointerLock(); } catch (e) { /* ignore */ }
            }
        }
        mtScheduler.setCondition("launch_called");
    }
}

// Pulled from builtin/mainmenu/settings/dlg_settings.lua
const SUPPORTED_LANGUAGES = [
	['be', "Беларуская [be]"],
	['bg', "Български [bg]"],
	['ca', "Català [ca]"],
	['cs', "Česky [cs]"],
	['cy', "Cymraeg [cy]"],
	['da', "Dansk [da]"],
	['de', "Deutsch [de]"],
	['el', "Ελληνικά [el]"],
	['en', "English [en]"],
	['eo', "Esperanto [eo]"],
	['es', "Español [es]"],
	['et', "Eesti [et]"],
	['eu', "Euskara [eu]"],
	['fi', "Suomi [fi]"],
	['fil', "Wikang Filipino [fil]"],
	['fr', "Français [fr]"],
	['gd', "Gàidhlig [gd]"],
	['gl', "Galego [gl]"],
	['hu', "Magyar [hu]"],
	['id', "Bahasa Indonesia [id]"],
	['it', "Italiano [it]"],
	['ja', "日本語 [ja]"],
	['jbo', "Lojban [jbo]"],
	['kk', "Қазақша [kk]"],
	['ko', "한국어 [ko]"],
	['ky', "Kırgızca / Кыргызча [ky]"],
	['lt', "Lietuvių [lt]"],
	['lv', "Latviešu [lv]"],
	['mn', "Монгол [mn]"],
	['mr', "मराठी [mr]"],
	['ms', "Bahasa Melayu [ms]"],
	['nb', "Norsk Bokmål [nb]"],
	['nl', "Nederlands [nl]"],
	['nn', "Norsk Nynorsk [nn]"],
	['oc', "Occitan [oc]"],
	['pl', "Polski [pl]"],
	['pt', "Português [pt]"],
	['pt_BR', "Português do Brasil [pt_BR]"],
	['ro', "Română [ro]"],
	['ru', "Русский [ru]"],
	['sk', "Slovenčina [sk]"],
	['sl', "Slovenščina [sl]"],
	['sr_Cyrl', "Српски [sr_Cyrl]"],
	['sr_Latn', "Srpski (Latinica) [sr_Latn]"],
	['sv', "Svenska [sv]"],
	['sw', "Kiswahili [sw]"],
	['tr', "Türkçe [tr]"],
	['tt', "Tatarça [tt]"],
	['uk', "Українська [uk]"],
	['vi', "Tiếng Việt [vi]"],
	['zh_CN', "中文 (简体) [zh_CN]"],
	['zh_TW', "正體中文 (繁體) [zh_TW]"],
];

const SUPPORTED_LANGUAGES_MAP = new Map(SUPPORTED_LANGUAGES);

function getDefaultLanguage() {
    const fuzzy = [];

    const url_params = new URLSearchParams(window.location.search);
    if (url_params.has("lang")) {
        const lang = url_params.get("lang");
        if (SUPPORTED_LANGUAGES_MAP.has(lang)) {
            return lang;
        }
        alert(`Invalid lang parameter: ${lang}`);
        return 'en';
    }

    for (let candidate of navigator.languages) {
        candidate = candidate.replaceAll('-', '_');

        if (SUPPORTED_LANGUAGES_MAP.has(candidate)) {
            return candidate;
        }

        // Try stripping off the country code
        const parts = candidate.split('_');
        if (parts.length > 2) {
            const rcandidate = parts.slice(0, 2).join('_');
            if (SUPPORTED_LANGUAGES_MAP.has(rcandidate)) {
                return rcandidate;
            }
        }

        // Try just matching the language code
        if (parts.length > 1) {
            if (SUPPORTED_LANGUAGES_MAP.has(parts[0])) {
                return parts[0];
            }
        }

        // Try fuzzy match (ignore country code of both)
        for (let entry of SUPPORTED_LANGUAGES) {
            if (entry[0].split('_')[0] == parts[0]) {
                fuzzy.push(entry[0]);
            }
        }
    }

    if (fuzzy.length > 0) {
        return fuzzy[0];
    }

    return 'en';
}
