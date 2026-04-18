/**
 * 在首屏 CSS 前执行：根据 localStorage 设置 html[data-theme]，并同步 meta theme-color。
 * 与 app.js 共用 family_portal_theme：light | dark | auto
 */
(function () {
    var KEY = "family_portal_theme";

    function syncThemeColorMeta() {
        var m = document.querySelector('meta[name="theme-color"]');
        if (!m) return;
        var mode = document.documentElement.getAttribute("data-theme") || "auto";
        var isLight =
            mode === "light" ||
            (mode === "auto" && window.matchMedia("(prefers-color-scheme: light)").matches);
        var light = m.getAttribute("data-light") || "#e8edf2";
        var dark = m.getAttribute("data-dark") || "#1a2332";
        m.content = isLight ? light : dark;
    }

    function init() {
        try {
            var t = localStorage.getItem(KEY);
            if (t === "light" || t === "dark") {
                document.documentElement.setAttribute("data-theme", t);
            } else {
                document.documentElement.setAttribute("data-theme", "auto");
            }
        } catch (e) {
            document.documentElement.setAttribute("data-theme", "auto");
        }
        syncThemeColorMeta();
        window
            .matchMedia("(prefers-color-scheme: light)")
            .addEventListener("change", function () {
                if (document.documentElement.getAttribute("data-theme") === "auto") {
                    syncThemeColorMeta();
                }
            });
    }

    window.familyPortalSetTheme = function (mode) {
        if (mode !== "light" && mode !== "dark" && mode !== "auto") return;
        document.documentElement.setAttribute("data-theme", mode);
        try {
            localStorage.setItem(KEY, mode);
        } catch (e) {
            /* ignore */
        }
        syncThemeColorMeta();
    };

    window.familyPortalSyncThemeColorMeta = syncThemeColorMeta;

    init();
})();
