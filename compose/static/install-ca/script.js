(function () {
  const tabs = document.querySelectorAll("#platform-tabs button");
  const panels = document.querySelectorAll("section[data-panel]");

  function show(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    panels.forEach((p) =>
      p.classList.toggle("active", p.dataset.panel === name),
    );
  }

  function detectPlatform() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return "ios";
    if (/Android/.test(ua)) return "android";
    if (/Mac/.test(ua)) return "macos";
    if (/Windows/.test(ua)) return "windows";
    if (/Linux/.test(ua)) return "linux";
    return "macos";
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => show(tab.dataset.tab));
  });

  show(detectPlatform());

  document.querySelectorAll(".copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const original = btn.textContent;
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = "Copied!";
      } catch {
        btn.textContent = "Copy failed — select manually";
      }
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    });
  });
})();
