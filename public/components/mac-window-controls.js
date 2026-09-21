(function () {
  const CSS = [
    ".mac-tl { -webkit-app-region: no-drag; display: flex; align-items: center; gap: 8px; margin: 0 10px 0 2px; order: -1; direction: ltr; flex: 0 0 auto; }",
    ".mac-tl button { width: 12px; height: 12px; border-radius: 50%; border: none; padding: 0; cursor: default; display: flex; align-items: center; justify-content: center; color: transparent; -webkit-user-select: none; user-select: none; transition: filter .15s ease; }",
    ".mac-tl button:active { filter: brightness(.8); }",
    ".mac-tl button svg { width: 8px; height: 8px; display: block; }",
    ".mac-tl:hover button { color: rgba(0,0,0,.55); }",
    ".mac-tl-close { background: #FF5F57; }",
    ".mac-tl-min { background: #FEBC2E; }",
    ".mac-tl-max { background: #28C840; }",
    ".mac-tl.is-hidden { display: none; }"
  ].join(String.fromCharCode(10));

  const style = document.createElement("style");
  style.id = "mac-window-controls-style";
  style.textContent = CSS;
  document.head.appendChild(style);

  // The page also runs in a plain browser preview where there is no Electron window;
  // require throws there and every control hides itself.
  function ipc() {
    try { return require("electron").ipcRenderer; } catch (e) { return null; }
  }

  function send(name) {
    const bus = ipc();
    if (!bus) return;
    try { bus.send(name); } catch (e) { /* window gone during shutdown */ }
  }

  function glyphClose() {
    return "<svg viewBox='0 0 10 10' stroke='currentColor' stroke-width='1.6' stroke-linecap='round' fill='none'><path d='M3 3l4 4M7 3L3 7'/></svg>";
  }
  function glyphMin() {
    return "<svg viewBox='0 0 10 10' stroke='currentColor' stroke-width='1.6' stroke-linecap='round' fill='none'><path d='M2 5h6'/></svg>";
  }
  // Maximise as macOS draws it: two small filled triangles, already diagonal.
  function glyphMax() {
    return "<svg viewBox='0 0 10 10' fill='currentColor'><path d='M2.2 6.1 6.1 2.2H2.2z'/><path d='M7.8 3.9 3.9 7.8h3.9z'/></svg>";
  }

  function mount() {
    const header = document.querySelector(".header-bar");
    if (!header || document.getElementById("mac-tl-group")) return;

    const group = document.createElement("div");
    group.id = "mac-tl-group";
    group.className = "mac-tl";

    const defs = [
      { cls: "mac-tl-close", title: "بستن", g: glyphClose(), fn: function () { send("window:close"); } },
      { cls: "mac-tl-min", title: "کوچک کردن", g: glyphMin(), fn: function () { send("window:minimize"); } },
      { cls: "mac-tl-max", title: "تمام‌صفحه", g: glyphMax(), fn: function () { send("window:maximize"); } }
    ];
    defs.forEach(function (d) {
      const b = document.createElement("button");
      b.className = d.cls;
      b.title = d.title;
      b.innerHTML = d.g;
      b.addEventListener("click", d.fn);
      group.appendChild(b);
    });

    header.insertBefore(group, header.firstChild);

    if (!ipc()) group.classList.add("is-hidden");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
