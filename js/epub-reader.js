class EPUBReader {
    constructor() {
        this.zip = null;
        this.currentIndex = 0;
        this.sections = [];
        this.readingUnits = [];
        this.hrefIndex = new Map();
        this.currentUnitHref = "";
        this.language = "en";
        this.messages = {
            es: {
                jumpTo: "Ir a",
                toc: "Indice",
                uploadPrompt: "Sube un archivo EPUB para comenzar a leer",
                uploadCta: "Elegir archivo EPUB",
                prev: "Anterior",
                next: "Siguiente",
                chapter: "Capitulo",
                section: "Seccion",
                noSections: "No se encontraron secciones legibles en el EPUB",
                chapterMissing: "No se encontro el archivo"
            },
            en: {
                jumpTo: "Jump to",
                toc: "Contents",
                uploadPrompt: "Upload an EPUB file to start reading",
                uploadCta: "Choose EPUB file",
                prev: "Previous",
                next: "Next",
                chapter: "Chapter",
                section: "Section",
                noSections: "No readable sections found in this EPUB",
                chapterMissing: "File not found"
            }
        };

        this.init();
    }

    init() {
        document.getElementById("file-input").addEventListener("change", (e) => this.handleFileUpload(e));
        document.getElementById("prev-btn").addEventListener("click", () => this.goTo(this.currentIndex - 1));
        document.getElementById("next-btn").addEventListener("click", () => this.goTo(this.currentIndex + 1));
        document.getElementById("hamburger-btn").addEventListener("click", () => this.toggleTocPanel());
        document.getElementById("reader-content").addEventListener("click", (e) => this.handleContentLinkClick(e));
        document.addEventListener("keydown", (e) => this.handleKeyboardNavigation(e));

        document.getElementById("font-size").addEventListener("change", (e) => {
            document.getElementById("reader-content").style.fontSize = e.target.value;
        });
        document.getElementById("font-family").addEventListener("change", (e) => {
            document.getElementById("reader-content").style.fontFamily = e.target.value;
        });

        document.getElementById("theme-light").addEventListener("click", () => this.setTheme("light"));
        document.getElementById("theme-dark").addEventListener("click", () => this.setTheme("dark"));
        document.getElementById("lang-select").addEventListener("change", (e) => this.setLanguage(e.target.value));

        this.setLanguage("en");
        this.setTheme("light");
    }

    t(key) {
        return this.messages[this.language][key] || key;
    }

    setLanguage(lang) {
        this.language = lang;
        document.documentElement.lang = lang;
        document.getElementById("lang-select").value = lang;
        document.querySelectorAll("[data-i18n]").forEach((el) => {
            el.textContent = this.t(el.dataset.i18n);
        });
        this.updateNavButtons();
        this.buildSectionSelectors();
    }

    setTheme(theme) {
        document.body.classList.toggle("dark-mode", theme === "dark");
        document.getElementById("theme-dark").classList.toggle("active", theme === "dark");
        document.getElementById("theme-light").classList.toggle("active", theme === "light");
    }

    async handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        await this.loadEPUB(await file.arrayBuffer());
    }

    async loadEPUB(arrayBuffer) {
        try {
            this.zip = await JSZip.loadAsync(arrayBuffer);
            const packageData = await this.readPackageData();
            this.sections = this.buildSpineSections(packageData.manifestById, packageData.spine, packageData.opfDir);

            if (!this.sections.length) throw new Error(this.t("noSections"));

            const tocEntries = await this.extractTOCEntries(packageData);
            this.readingUnits = tocEntries.length ? this.dedupeEntries(tocEntries) : this.sections.map((s, idx) => ({
                label: `${this.t("section")} ${idx + 1}`,
                href: s.href,
                sourceIndex: idx
            }));

            document.getElementById("welcome-screen").style.display = "none";
            document.getElementById("toc-panel").classList.add("is-visible");
            this.currentIndex = 0;
            this.buildSectionSelectors();
            this.rebuildHrefIndex();
            await this.goTo(0);
        } catch (error) {
            alert(error.message || "EPUB load error");
            console.error(error);
        }
    }

    async readPackageData() {
        const containerFile = this.zip.file("META-INF/container.xml");
        if (!containerFile) throw new Error("Invalid EPUB: container.xml missing");

        const containerText = await containerFile.async("string");
        const containerDoc = new DOMParser().parseFromString(containerText, "text/xml");
        const rootfile = containerDoc.querySelector("rootfile");
        if (!rootfile) throw new Error("Invalid EPUB: OPF package path missing");

        const opfPath = rootfile.getAttribute("full-path");
        const opfFile = this.zip.file(opfPath);
        if (!opfFile) throw new Error("Invalid EPUB: OPF package not found");

        const opfText = await opfFile.async("string");
        const opfDoc = new DOMParser().parseFromString(opfText, "text/xml");

        const manifestById = new Map();
        opfDoc.querySelectorAll("manifest > item").forEach((item) => {
            manifestById.set(item.getAttribute("id"), {
                id: item.getAttribute("id"),
                href: item.getAttribute("href"),
                mediaType: item.getAttribute("media-type"),
                properties: item.getAttribute("properties") || ""
            });
        });

        const spine = Array.from(opfDoc.querySelectorAll("spine > itemref"))
            .map((el) => el.getAttribute("idref"))
            .filter(Boolean);

        const tocId = opfDoc.querySelector("spine")?.getAttribute("toc") || "";
        const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
        return { opfDoc, manifestById, spine, opfDir, tocId };
    }

    buildSpineSections(manifestById, spine, opfDir) {
        return spine
            .map((idref, index) => {
                const item = manifestById.get(idref);
                if (!item || !item.href) return null;
                return { id: idref, index, href: this.resolvePath(opfDir, item.href) };
            })
            .filter(Boolean);
    }

    async extractTOCEntries(packageData) {
        const navEntries = await this.extractNavXhtmlEntries(packageData);
        if (navEntries.length) return navEntries;
        return this.extractNCXEntries(packageData);
    }

    async extractNavXhtmlEntries({ manifestById, opfDir }) {
        const navItem = Array.from(manifestById.values()).find((item) =>
            item.properties.split(" ").includes("nav")
        );
        if (!navItem) return [];

        const navPath = this.resolvePath(opfDir, navItem.href);
        const navFile = this.zip.file(navPath);
        if (!navFile) return [];

        const navHtml = await navFile.async("string");
        const navDoc = new DOMParser().parseFromString(navHtml, "text/html");
        const tocNav = navDoc.querySelector("nav[epub\\:type='toc'], nav[*|type='toc'], nav#toc, nav.toc") || navDoc.querySelector("nav");
        if (!tocNav) return [];

        const anchors = Array.from(tocNav.querySelectorAll("a[href]"));
        return anchors.map((a, idx) => ({
            label: (a.textContent || "").trim() || `${this.t("chapter")} ${idx + 1}`,
            href: this.resolvePath(opfDir, a.getAttribute("href"))
        }));
    }

    async extractNCXEntries({ manifestById, opfDir, tocId }) {
        let ncxItem = tocId ? manifestById.get(tocId) : null;
        if (!ncxItem) {
            ncxItem = Array.from(manifestById.values()).find((item) =>
                item.mediaType === "application/x-dtbncx+xml"
            );
        }
        if (!ncxItem) return [];

        const ncxPath = this.resolvePath(opfDir, ncxItem.href);
        const ncxFile = this.zip.file(ncxPath);
        if (!ncxFile) return [];

        const ncxText = await ncxFile.async("string");
        const ncxDoc = new DOMParser().parseFromString(ncxText, "text/xml");
        const navPoints = Array.from(ncxDoc.querySelectorAll("navPoint"));
        return navPoints.map((point, idx) => {
            const label = point.querySelector("navLabel > text")?.textContent?.trim() || `${this.t("chapter")} ${idx + 1}`;
            const src = point.querySelector("content")?.getAttribute("src") || "";
            return { label, href: this.resolvePath(opfDir, src) };
        }).filter((entry) => entry.href);
    }

    dedupeEntries(entries) {
        const seen = new Set();
        const result = [];
        entries.forEach((entry) => {
            const key = entry.href;
            if (seen.has(key)) return;
            seen.add(key);
            result.push(entry);
        });
        return result;
    }

    rebuildHrefIndex() {
        this.hrefIndex.clear();

        this.readingUnits.forEach((unit, idx) => {
            const normalized = this.normalizeHref(unit.href);
            this.hrefIndex.set(normalized.full, idx);
            this.hrefIndex.set(normalized.path, idx);
        });

        this.sections.forEach((section, idx) => {
            const normalized = this.normalizeHref(section.href);
            if (!this.hrefIndex.has(normalized.path)) {
                this.hrefIndex.set(normalized.path, idx);
            }
        });
    }

    normalizeHref(href) {
        const safeHref = href || "";
        const [pathWithQuery, fragment] = safeHref.split("#");
        const path = pathWithQuery.split("?")[0];
        const cleanPath = path.replace(/^\//, "");
        return {
            full: fragment ? `${cleanPath}#${fragment}` : cleanPath,
            path: cleanPath,
            fragment: fragment || ""
        };
    }

    resolveRelativeToCurrent(href) {
        if (href.startsWith("#")) {
            const base = this.normalizeHref(this.currentUnitHref).path;
            return `${base}${href}`;
        }

        const currentPath = this.normalizeHref(this.currentUnitHref).path;
        const baseDir = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/") + 1) : "";
        const withNoQuery = href.split("?")[0];
        const [relativePath, fragment] = withNoQuery.split("#");
        const resolvedPath = this.resolvePath(baseDir, relativePath || currentPath);
        return fragment ? `${resolvedPath}#${fragment}` : resolvedPath;
    }

    async handleContentLinkClick(event) {
        const link = event.target.closest("a[href]");
        if (!link) return;

        const rawHref = link.getAttribute("href") || "";
        if (!rawHref || rawHref.startsWith("mailto:") || rawHref.startsWith("tel:")) {
            return;
        }

        const absoluteHref = link.href || "";
        const isSameOrigin = absoluteHref.startsWith(window.location.origin);
        const isEpubRelative = !rawHref.includes(":") || rawHref.startsWith("#");
        if (!isEpubRelative && !isSameOrigin) return;

        event.preventDefault();

        const resolved = this.resolveRelativeToCurrent(rawHref);
        const normalized = this.normalizeHref(resolved);
        const unitIndex = this.hrefIndex.get(normalized.full) ?? this.hrefIndex.get(normalized.path);

        if (unitIndex !== undefined) {
            await this.goTo(unitIndex);

            if (normalized.fragment) {
                const article = document.getElementById("reader-content");
                const target = article.querySelector(`#${CSS.escape(normalized.fragment)}`) || article.querySelector(`[name='${normalized.fragment.replace(/'/g, "\\'")}']`);
                if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
            }
            return;
        }

        const file = this.zip.file(normalized.path);
        if (file) {
            await this.renderUnit({ href: normalized.full });
            this.updateNavButtons();
            return;
        }

        alert(`${this.t("chapterMissing")}: ${normalized.path}`);
    }

    handleKeyboardNavigation(event) {
        const tag = event.target?.tagName || "";
        const isTypingField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target?.isContentEditable;
        if (isTypingField || !this.readingUnits.length) return;

        if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            this.goTo(this.currentIndex + 1);
            return;
        }

        if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            this.goTo(this.currentIndex - 1);
        }
    }

    resolvePath(baseDir, relativePath) {
        const normalizedBase = baseDir ? `https://epub.local/${baseDir}` : "https://epub.local/";
        return new URL(relativePath, normalizedBase).pathname.replace(/^\//, "");
    }

    buildSectionSelectors() {
        const toc = document.getElementById("toc-list");
        if (!toc || !this.readingUnits.length) return;
        toc.innerHTML = "";

        this.readingUnits.forEach((unit, index) => {
            const label = unit.label || `${this.t("chapter")} ${index + 1}`;

            const link = document.createElement("button");
            link.type = "button";
            link.className = "toc-item";
            link.textContent = label;
            link.addEventListener("click", () => this.goTo(index));
            toc.appendChild(link);
        });
    }

    toggleTocPanel() {
        const panel = document.getElementById("toc-panel");
        const btn = document.getElementById("hamburger-btn");
        const collapsed = panel.classList.toggle("is-collapsed");
        btn.setAttribute("aria-expanded", String(!collapsed));
    }

    async goTo(index) {
        if (!this.readingUnits.length) return;
        if (index < 0 || index >= this.readingUnits.length) return;
        this.currentIndex = index;
        await this.renderUnit(this.readingUnits[index]);
        this.updateNavButtons();
    }

    async renderUnit(unit) {
        const [chapterPath, fragment] = unit.href.split("#");
        this.currentUnitHref = unit.href;
        const file = this.zip.file(chapterPath);
        if (!file) throw new Error(`${this.t("chapterMissing")}: ${chapterPath}`);

        const raw = await file.async("string");
        const doc = new DOMParser().parseFromString(raw, "text/html");
        const article = document.getElementById("reader-content");
        if (!article) throw new Error("Reader content container missing");
        article.innerHTML = doc.body ? doc.body.innerHTML : raw;
        await this.hydrateEmbeddedResources(chapterPath, article);

        if (fragment) {
            requestAnimationFrame(() => {
                const target = article.querySelector(`#${CSS.escape(fragment)}`) || article.querySelector(`[name='${fragment.replace(/'/g, "\\'")}']`);
                if (target) target.scrollIntoView({ behavior: "instant", block: "start" });
            });
        } else {
            document.getElementById("content").scrollTop = 0;
        }

        document.querySelectorAll(".toc-item").forEach((el, idx) => el.classList.toggle("active", idx === this.currentIndex));
    }

    async hydrateEmbeddedResources(chapterPath, root) {
        const chapterDir = chapterPath.includes("/") ? chapterPath.slice(0, chapterPath.lastIndexOf("/") + 1) : "";
        const nodes = root.querySelectorAll("img[src], image[href], image[xlink\\:href], source[src], audio[src], video[src]");

        for (const el of nodes) {
            const attr = el.hasAttribute("src") ? "src" : (el.hasAttribute("href") ? "href" : "xlink:href");
            const rawRef = el.getAttribute(attr);
            if (!rawRef || rawRef.startsWith("data:") || rawRef.startsWith("http://") || rawRef.startsWith("https://")) {
                continue;
            }

            const resolvedPath = this.resolvePath(chapterDir, rawRef.split("#")[0]);
            const resource = this.zip.file(resolvedPath);
            if (!resource) continue;

            const blob = await resource.async("blob");
            const objectUrl = URL.createObjectURL(blob);
            el.setAttribute(attr, objectUrl);
        }
    }

    updateNavButtons() {
        const prevBtn = document.getElementById("prev-btn");
        const nextBtn = document.getElementById("next-btn");
        prevBtn.textContent = `◀ ${this.t("prev")}`;
        nextBtn.textContent = `${this.t("next")} ▶`;
        prevBtn.disabled = this.currentIndex === 0;
        nextBtn.disabled = this.currentIndex >= this.readingUnits.length - 1;
        document.getElementById("chapter-info").textContent = `${this.currentIndex + 1}/${this.readingUnits.length}`;
    }
}

document.addEventListener("DOMContentLoaded", () => {
    new EPUBReader();
});
