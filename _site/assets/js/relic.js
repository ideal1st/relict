pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

let books = [];
let activeBookId = null;
let db;
let currentURL = null;
let recentFolders = [];
let cbzUrls = []; 
let currentBook = null;
let currentRendition = null; 
let currentView = 'grid'; 

// EPUB display preferences
let epubSpreadMode = 'double';     // 'single' or 'double'
let epubSeparateCover = true;      // true: cover shown alone; false: cover paired on spread
let isAdjustingSpread = false;

try {
    const savedSpread = localStorage.getItem('relic_epub_spread');
    if (savedSpread === 'single' || savedSpread === 'double') epubSpreadMode = savedSpread;
    const savedCover = localStorage.getItem('relic_epub_separate_cover');
    if (savedCover !== null) epubSeparateCover = (savedCover === '1');
} catch (e) {}

function showToast(message, type = 'info') {
    const toast = document.getElementById('status-toast');
    if (!toast) return;
    toast.className = `alert alert-${type} py-2 px-3 mb-3 shadow-sm small`;
    toast.textContent = message;
    toast.classList.remove('d-none');
    setTimeout(() => {
        toast.classList.add('d-none');
    }, 4000);
}

// --- VIEW MODE-SWITCHING TOGGLE ---
function setView(viewType) {
    currentView = viewType;
    const gridBtn = document.getElementById('view-grid');
    const listBtn = document.getElementById('view-list');
    if (gridBtn) gridBtn.classList.toggle('active', viewType === 'grid');
    if (listBtn) listBtn.classList.toggle('active', viewType === 'list');
    renderGrid();
}

// --- DYNAMIC TRACKING OBSERVER ---
const observerOptions = {
    root: null, 
    threshold: 0.5 
};

const pageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const b = books.find(x => x.id === activeBookId);
            if (!b) return;

            const pageNum = entry.target.dataset.page;
            const locInput = document.getElementById('note-location');
            const cfiInput = document.getElementById('note-cfi');

            if (b.type === 'cbz') {
                if (locInput) locInput.value = `Img ${pageNum}`;
                if (cfiInput) cfiInput.value = pageNum;
            } else if (b.type === 'pdf') {
                if (locInput) locInput.value = `Page ${pageNum}`;
                if (cfiInput) cfiInput.value = pageNum;
            }
        }
    });
}, observerOptions);

// --- DATABASE CORE ---
const request = indexedDB.open("LibraryCache", 4);
request.onupgradeneeded = e => {
    const d = e.target.result;
    if (!d.objectStoreNames.contains("books")) d.createObjectStore("books", { keyPath: "name" });
    if (!d.objectStoreNames.contains("folders")) d.createObjectStore("folders", { keyPath: "name" });
};
request.onsuccess = e => { 
    db = e.target.result; 
    loadRecentFolders(); 
};

// --- FOLDER MANAGEMENT ---
async function loadRecentFolders() {
    if (!db) return;
    const trans = db.transaction("folders", "readonly");
    const req = trans.objectStore("folders").getAll();
    req.onsuccess = () => { 
        recentFolders = req.result || []; 
        renderFolderList(); 
    };
}

async function saveFolderToDB(folderObj) {
    if (!db) return;
    const trans = db.transaction("folders", "readwrite");
    trans.objectStore("folders").put(folderObj);
}

function toggleDrawer() {
    const drawer = document.getElementById('drawer');
    const overlay = document.getElementById('drawer-overlay');
    if (drawer) drawer.classList.toggle('open');
    if (overlay) overlay.classList.toggle('open');
}

function renderFolderList() {
    const list = document.getElementById('folder-list');
    if (!list) return;
    if (recentFolders.length === 0) { 
        list.innerHTML = '<p class="text-muted small text-center mt-3">Empty history.</p>'; 
        return; 
    }
    list.innerHTML = recentFolders.sort((a,b) => b.pinned - a.pinned || b.lastOpened - a.lastOpened).slice(0, 10).map((f) => `
        <div class="folder-item">
            <div class="text-truncate flex-grow-1 small fw-bold" onclick="reconnectFolder('${escapeHtml(f.name)}')">
                <i data-lucide="folder" class="me-2 text-warning" style="width:14px"></i> ${escapeHtml(f.name)}
            </div>
            <i data-lucide="pin" class="${f.pinned ? 'pinned-icon' : 'text-muted'}" style="width:16px; cursor:pointer" onclick="togglePin('${escapeHtml(f.name)}')"></i>
        </div>
    `).join('');
    if (window.lucide) lucide.createIcons();
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function togglePin(name) {
    const f = recentFolders.find(x => x.name === name);
    if (!f) return;
    f.pinned = !f.pinned;
    await saveFolderToDB(f);
    renderFolderList();
}

function initFiles() {
    const input = document.getElementById('files-input');
    if (input) input.click();
}

async function initLibrary() { 
    if (window.showDirectoryPicker) {
        try { 
            const handle = await window.showDirectoryPicker(); 
            await processFolder(handle); 
            return;
        } catch (e) {
            if (e.name === 'AbortError') return;
            console.warn('showDirectoryPicker unavailable or declined, falling back to input:', e);
        }
    }
    const folderInput = document.getElementById('folder-input');
    if (folderInput) {
        folderInput.click();
    }
}

async function handleFolderSelect(event) {
    if (event.target.files && event.target.files.length > 0) {
        const files = Array.from(event.target.files);
        const folderName = files[0].webkitRelativePath ? files[0].webkitRelativePath.split('/')[0] : 'Library Folder';
        await processFileList(files, folderName);
    }
}

async function handleFilesSelect(event) {
    if (event.target.files && event.target.files.length > 0) {
        const files = Array.from(event.target.files);
        await processFileList(files, 'Imported Files');
    }
}

async function reconnectFolder(name) {
    const folder = recentFolders.find(f => f.name === name);
    if (!folder) return;
    if (folder.handle && folder.handle.requestPermission) {
        try {
            if (await folder.handle.requestPermission({ mode: 'read' }) === 'granted') {
                processFolder(folder.handle);
                toggleDrawer();
                return;
            }
        } catch (e) {
            console.warn('Permission re-request failed:', e);
        }
    }
    initLibrary();
}

async function processFolder(handle) {
    const folderData = { name: handle.name, handle: handle, lastOpened: Date.now(), pinned: false };
    const existing = recentFolders.find(f => f.name === handle.name);
    if (existing) folderData.pinned = existing.pinned;
    await saveFolderToDB(folderData);
    loadRecentFolders();
    books = [];
    document.getElementById('grid').innerHTML = '<div class="text-center w-100 py-5"><div class="spinner-border text-info"></div><p class="mt-2 text-muted">Indexing files in folder...</p></div>';
    
    for await (const entry of handle.values()) {
        if (entry.kind === 'file') {
            const file = await entry.getFile();
            await ingestFile(file);
        }
    }
    renderGrid();
    showToast(`Loaded folder "${handle.name}"`, 'success');
}

async function processFileList(files, folderName = 'Library') {
    const folderData = { name: folderName, lastOpened: Date.now(), pinned: false };
    const existing = recentFolders.find(f => f.name === folderName);
    if (existing) folderData.pinned = existing.pinned;
    await saveFolderToDB(folderData);
    loadRecentFolders();
    books = [];
    document.getElementById('grid').innerHTML = '<div class="text-center w-100 py-5"><div class="spinner-border text-info"></div><p class="mt-2 text-muted">Indexing files...</p></div>';

    for (const file of files) {
        await ingestFile(file);
    }
    renderGrid();
    showToast(`Loaded ${books.length} book(s) into library`, 'success');
}

async function ingestFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (['pdf', 'epub', 'cbz'].includes(ext)) {
        const stored = await getStoredBookData(file.name);
        let pageCount = stored ? (stored.pages || 0) : 0;
        if (pageCount === 0) {
            try {
                if (ext === 'pdf') {
                    const pdfData = await file.arrayBuffer();
                    const pdf = await pdfjsLib.getDocument({data: pdfData}).promise;
                    pageCount = pdf.numPages;
                } else if (ext === 'cbz') {
                    const zip = await JSZip.loadAsync(file);
                    pageCount = Object.keys(zip.files).filter(name => /\.(jpg|jpeg|png|webp)$/i.test(name)).length;
                } else if (ext === 'epub') {
                    const book = ePub(file);
                    await book.ready;
                    const locations = await book.locations.generate(1800);
                    pageCount = locations.length;
                    book.destroy();
                }
                saveBookData(file.name, { pages: pageCount });
            } catch (e) {
                console.warn(`Failed to count pages for ${file.name}:`, e);
            }
        }
        books.push({
            id: Math.random().toString(36).substr(2, 9),
            name: file.name, blob: file, size: file.size, date: file.lastModified, type: ext,
            pages: pageCount, lastAccessed: new Date().toLocaleString(),
            cover: stored ? stored.cover : null, tags: stored ? (stored.tags || []) : [], notes: stored ? (stored.notes || []) : []
        });
        renderGrid();
        if (!stored?.cover) {
            if (ext === 'pdf') generatePDFCover(file, file.name);
            else if (ext === 'epub') generateEPUBCover(file, file.name);
            else if (ext === 'cbz') generateCBZCover(file, file.name);
        }
    }
}



// --- RENDER ENGINES ---
async function renderPDFMobile(blob, pageNum = 1) {
    const canvas = document.getElementById('pdf-canvas');
    if (!canvas) return;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    const url = URL.createObjectURL(blob);
    const pdf = await pdfjsLib.getDocument(url).promise;
    const page = await pdf.getPage(pageNum);
    
    document.getElementById('note-location').value = `Page ${pageNum}`;
    document.getElementById('note-cfi').value = pageNum;

    const viewport = page.getViewport({ scale: 1.5 });
    canvas.height = viewport.height; 
    canvas.width = viewport.width;
    await page.render({ canvasContext: context, viewport: viewport }).promise;
    URL.revokeObjectURL(url);
}

// --- EPUB 2-PAGE SPREAD & SEPARATE COVER SYSTEM ---

function isAtCover(location) {
    if (!location || !location.start) return false;
    // Section 0 is typically the cover/title page
    if (location.start.index === 0) {
        if (location.start.displayed && location.start.displayed.page) {
            return location.start.displayed.page === 1;
        }
        return true;
    }
    // Check href or idref for "cover"
    if (location.start.href && /cover/i.test(location.start.href)) {
        return true;
    }
    return false;
}

function updateEpubControlUI() {
    const btnSingle = document.getElementById('btn-epub-single');
    const btnDouble = document.getElementById('btn-epub-double');
    const chkCover = document.getElementById('epub-cover-separate');
    const coverWrapper = document.getElementById('epub-cover-wrapper');

    if (btnSingle) btnSingle.classList.toggle('active', epubSpreadMode === 'single');
    if (btnDouble) btnDouble.classList.toggle('active', epubSpreadMode === 'double');

    if (chkCover) {
        chkCover.checked = epubSeparateCover;
        chkCover.disabled = (epubSpreadMode === 'single');
    }
    if (coverWrapper) {
        if (epubSpreadMode === 'single') {
            coverWrapper.classList.add('opacity-50');
            coverWrapper.title = 'Separate cover is available in 2 Pages mode';
        } else {
            coverWrapper.classList.remove('opacity-50');
            coverWrapper.title = 'Display the book cover alone on the first spread';
        }
    }
}

function setEpubSpreadMode(mode) {
    epubSpreadMode = mode;
    try { localStorage.setItem('relic_epub_spread', mode); } catch (e) {}
    updateEpubControlUI();

    if (!currentRendition) return;

    const loc = currentRendition.currentLocation();
    const isCover = isAtCover(loc);
    const container = document.getElementById('epub-viewer');

    let targetSpread = 'none';
    if (epubSpreadMode === 'double') {
        if (epubSeparateCover && isCover) {
            targetSpread = 'none';
            if (container) container.classList.remove('spread-double');
        } else {
            targetSpread = 'always';
            if (container) container.classList.add('spread-double');
        }
    } else {
        targetSpread = 'none';
        if (container) container.classList.remove('spread-double');
    }

    currentRendition.spread(targetSpread, targetSpread === 'always' ? 0 : 800);
    if (loc && loc.start && loc.start.cfi) {
        currentRendition.display(loc.start.cfi);
    }
}

function setEpubSeparateCover(enabled) {
    epubSeparateCover = enabled;
    try { localStorage.setItem('relic_epub_separate_cover', enabled ? '1' : '0'); } catch (e) {}
    updateEpubControlUI();

    if (!currentRendition || epubSpreadMode !== 'double') return;

    const loc = currentRendition.currentLocation();
    const isCover = isAtCover(loc);
    const container = document.getElementById('epub-viewer');

    let targetSpread = (epubSeparateCover && isCover) ? 'none' : 'always';
    if (container) {
        if (targetSpread === 'always') container.classList.add('spread-double');
        else container.classList.remove('spread-double');
    }

    currentRendition.spread(targetSpread, targetSpread === 'always' ? 0 : 800);
    if (loc && loc.start && loc.start.cfi) {
        currentRendition.display(loc.start.cfi);
    }
}

function handleEpubRelocated(location) {
    if (!currentBook || !currentRendition) return;

    if (currentBook.locations && location.start && location.start.cfi) {
        const percent = Math.floor(currentBook.locations.percentageFromCfi(location.start.cfi) * 100);
        const locInput = document.getElementById('note-location');
        const cfiInput = document.getElementById('note-cfi');
        if (locInput) locInput.value = percent + "%";
        if (cfiInput) cfiInput.value = location.start.cfi;
        updateProgress(currentBook);
    }

    // Dynamic cover separation in 2-page spread mode
    if (epubSpreadMode === 'double' && !isAdjustingSpread) {
        const isCover = isAtCover(location);
        const container = document.getElementById('epub-viewer');

        if (epubSeparateCover && isCover) {
            // Display cover alone
            if (currentRendition.settings.spread !== 'none') {
                isAdjustingSpread = true;
                if (container) container.classList.remove('spread-double');
                currentRendition.spread('none');
                setTimeout(() => { isAdjustingSpread = false; }, 300);
            }
        } else {
            // Display 2 pages spread
            if (currentRendition.settings.spread !== 'always') {
                isAdjustingSpread = true;
                if (container) container.classList.add('spread-double');
                currentRendition.spread('always', 0);
                setTimeout(() => { isAdjustingSpread = false; }, 300);
            }
        }
    }
}

function renderEPUB(blob) {
    if (typeof ePub === 'undefined') return;
    const container = document.getElementById('epub-viewer');
    const controls = document.getElementById('epub-controls');
    const topControls = document.getElementById('epub-top-controls');
    
    if (topControls) topControls.style.display = 'flex';
    container.innerHTML = '';

    if (currentRendition) {
        try { currentRendition.destroy(); } catch (e) {}
        currentRendition = null;
    }
    if (currentBook) {
        try { currentBook.destroy(); } catch (e) {}
        currentBook = null;
    }

    currentBook = ePub(blob);

    // Initial spread layout
    const initialSpread = epubSpreadMode === 'double' ? (epubSeparateCover ? 'none' : 'always') : 'none';

    currentRendition = currentBook.renderTo("epub-viewer", {
        width: "100%",
        height: "100%",
        flow: "paginated",
        spread: initialSpread,
        minSpreadWidth: initialSpread === 'always' ? 0 : 800
    });

    if (initialSpread === 'always') {
        container.classList.add('spread-double');
    } else {
        container.classList.remove('spread-double');
    }

    // Register content hooks (forward keydown navigation from inside iframe)
    currentRendition.hooks.content.register((contents) => {
        const doc = contents.document;
        if (doc) {
            // Forward keydown navigation inside the iframe
            doc.addEventListener('keydown', (evt) => {
                if (evt.key === 'ArrowRight' || evt.key === 'PageDown' || evt.key === ' ') {
                    evt.preventDefault();
                    nextPage();
                } else if (evt.key === 'ArrowLeft' || evt.key === 'PageUp') {
                    evt.preventDefault();
                    prevPage();
                } else if (evt.key === 'Escape') {
                    closeReader();
                }
            });
        }
    });

    currentRendition.display().then(() => {
        if (controls) controls.classList.add('dimmed');
    });

    currentRendition.on("click", () => {
        if (controls) controls.classList.add('dimmed');
    });

    currentBook.ready.then(() => currentBook.locations.generate(1800)).then(() => updateProgress(currentBook));

    currentRendition.on("relocated", (location) => {
        handleEpubRelocated(location);
    });

    updateEpubControlUI();
}

function seekEpub(value) {
    if (currentRendition && currentRendition.book && currentRendition.book.locations) {
        const percentage = value / 100;
        const cfi = currentRendition.book.locations.cfiFromPercentage(percentage);
        currentRendition.display(cfi);
    }
}

async function renderCBZ(blob) {
    const container = document.getElementById('cbz-viewer');
    container.innerHTML = '';
    cleanupCBZ();
    const zip = await JSZip.loadAsync(blob);
    const images = Object.keys(zip.files).filter(n => /\.(jpg|jpeg|png|webp)$/i.test(n)).sort();
    for (let i = 0; i < images.length; i++) {
        const imgBlob = await zip.files[images[i]].async("blob");
        const url = URL.createObjectURL(imgBlob);
        cbzUrls.push(url);
        const img = document.createElement('img');
        img.src = url;
        img.className = "img-fluid mb-2 cbz-page";
        img.dataset.page = i + 1;
        container.appendChild(img);
        pageObserver.observe(img);
    }
    const firstImg = images.length > 0 ? 1 : '';
    document.getElementById('note-location').value = firstImg ? `Img ${firstImg}` : '';
    document.getElementById('note-cfi').value = firstImg;
}

// --- READER DISPATCH ---
function openBook(id) {
    activeBookId = id; 
    const b = books.find(x => x.id === id);
    if (!b) return;
    
    const viewers = {
        pdf: document.getElementById('pdf-viewer-frame'),
        canvas: document.getElementById('pdf-canvas'),
        epub: document.getElementById('epub-viewer'),
        cbz: document.getElementById('cbz-viewer')
    };
    
    document.getElementById('note-location').value = '';
    document.getElementById('note-cfi').value = '';
    
    Object.values(viewers).forEach(el => { if (el) el.style.display = 'none'; });
    document.getElementById('reader-overlay').style.display = 'block';
    document.getElementById('reading-title').innerText = b.name;
    
    const badge = document.getElementById('reading-badge');
    if (badge) {
        badge.innerText = b.type.toUpperCase();
        badge.className = `badge bg-${b.type === 'epub' ? 'warning text-dark' : (b.type === 'pdf' ? 'danger' : 'info')} text-uppercase`;
    }

    const topControls = document.getElementById('epub-top-controls');
    document.getElementById('epub-controls').style.display = (b.type === 'epub') ? 'block' : 'none';

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (b.type === 'pdf') {
        if (topControls) topControls.style.display = 'none';
        if (isMobile) {
            viewers.canvas.style.display = 'block';
            renderPDFMobile(b.blob);
        } else {
            const fileURL = URL.createObjectURL(b.blob);
            const viewerPath = '/assets/pdfjs/web/viewer.html'; 
            viewers.pdf.src = `${viewerPath}?file=${encodeURIComponent(fileURL)}`;
            viewers.pdf.style.display = 'block';
    
            viewers.pdf.onload = () => {
                try {
                    const viewerApp = viewers.pdf.contentWindow.PDFViewerApplication;
                    if (viewerApp && viewerApp.eventBus) {
                        viewerApp.eventBus.on('pagechanging', (evt) => {
                            const pageNum = evt.pageNumber;
                            document.getElementById('note-location').value = `Page ${pageNum}`;
                            document.getElementById('note-cfi').value = pageNum;
                        });
                    }
                } catch (e) {
                    console.warn('PDF frame access note:', e);
                }
            };
        }
    } else if (b.type === 'epub') {
        if (topControls) topControls.style.display = 'flex';
        viewers.epub.style.display = 'block';
        renderEPUB(b.blob);
    } else if (b.type === 'cbz') {
        if (topControls) topControls.style.display = 'none';
        viewers.cbz.style.display = 'block';
        renderCBZ(b.blob);
    }
    renderNotes();
}

function closeReader() {
    document.getElementById('reader-overlay').style.display = 'none';
    const pdfFrame = document.getElementById('pdf-viewer-frame');
    if (pdfFrame) pdfFrame.src = '';
    const controls = document.getElementById('epub-controls');
    if (controls) controls.classList.remove('dimmed');
    const topControls = document.getElementById('epub-top-controls');
    if (topControls) topControls.style.display = 'none';

    if (currentRendition) {
        try { currentRendition.destroy(); } catch (e) {}
        currentRendition = null;
    }
    if (currentBook) {
        try { currentBook.destroy(); } catch (e) {}
        currentBook = null;
    }

    pageObserver.disconnect();
    cleanupCBZ();
}

// Global keyboard navigation
document.addEventListener('keydown', (e) => {
    const overlay = document.getElementById('reader-overlay');
    if (!overlay || overlay.style.display !== 'block') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        nextPage();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        prevPage();
    } else if (e.key === 'Escape') {
        closeReader();
    }
});

// --- NOTE TAKING SYSTEM ---
function renderNotes() {
    const b = books.find(x => x.id === activeBookId);
    const list = document.getElementById('notes-list');
    const query = (document.getElementById('note-search')?.value || '').toLowerCase();
    if (!b || !b.notes || !list) return;
    
    list.innerHTML = b.notes
        .filter(n => n.text.toLowerCase().includes(query))
        .sort((a, b) => {
            if (a.page !== b.page) return a.page - b.page;
            return String(a.value).localeCompare(String(b.value), undefined, { numeric: true });
        })
        .map((n) => {
            const originalIndex = b.notes.findIndex(note => note === n);
            let highlightedText = escapeHtml(n.text);
            if (query) {
                const regex = new RegExp(`(${query})`, 'gi');
                highlightedText = highlightedText.replace(regex, '<mark>$1</mark>');
            }
            let label = (b.type === 'cbz') ? `Img ${n.page}` : (b.type === 'pdf') ? `Page ${n.page}` : `${n.page}`;
            if (b.type === 'epub') label = n.display || `${n.page}%`;

            return `
                <div class="mb-3 p-2 border rounded bg-light small position-relative">
                    <span class="badge bg-primary cursor-pointer mb-2" onclick="jumpToLocation('${escapeHtml(String(n.value || n.page))}')">
                        ${escapeHtml(label)}
                    </span>
                    <div class="text-dark">${highlightedText}</div>
                    <button class="btn btn-xs btn-link text-danger p-0" style="position:absolute; top:2px; right:8px" onclick="deleteNote(${originalIndex})">&times;</button>
                </div>
            `;
        }).join('');
}

async function addNote() {
    const b = books.find(x => x.id === activeBookId);
    const locLabel = document.getElementById('note-location').value;
    const locValue = document.getElementById('note-cfi').value;
    const text = document.getElementById('note-text').value.trim();

    if (text && b) {
        const pageNum = (b.type === 'epub') ? 0 : (parseInt(locValue) || 1);
        
        b.notes.push({ 
            page: pageNum, 
            value: locValue, 
            display: locLabel, 
            text: text 
        });
        
        await saveBookData(b.name, { notes: b.notes });
        document.getElementById('note-text').value = '';
        renderNotes();
        showToast('Note saved!', 'success');
    }
}

async function jumpToLocation(val) {
    const b = books.find(x => x.id === activeBookId);
    if (!b) return;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (b.type === 'epub' && currentRendition) {
        currentRendition.display(val);
    } else if (b.type === 'pdf') {
        if (isMobile) {
            renderPDFMobile(b.blob, parseInt(val));
        } else {
            const viewerFrame = document.getElementById('pdf-viewer-frame');
            try {
                const viewerApp = viewerFrame?.contentWindow?.PDFViewerApplication;
                if (viewerApp) viewerApp.page = parseInt(val);
            } catch (e) {}
        }
    } else if (b.type === 'cbz') {
        const imgs = document.querySelectorAll('.cbz-page');
        const idx = parseInt(val) - 1;
        if (imgs[idx]) imgs[idx].scrollIntoView({ behavior: 'smooth' });
    }
}

// --- SUPPORT FUNCTIONS ---
async function getStoredBookData(name) {
    if (!db) return null;
    return new Promise(r => {
        const trans = db.transaction("books", "readonly");
        const req = trans.objectStore("books").get(name);
        req.onsuccess = () => r(req.result || null);
        req.onerror = () => r(null);
    });
}

async function saveBookData(name, newData) {
    if (!db) return;
    const existing = await getStoredBookData(name) || { name, tags: [], cover: null, notes: [], pageCount: 0 };
    const updated = { ...existing, ...newData };
    const trans = db.transaction("books", "readwrite");
    trans.objectStore("books").put(updated);
}

async function generatePDFCover(file, fileName) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
        const page = await pdf.getPage(1);
        const canvas = document.createElement('canvas');
        const viewport = page.getViewport({scale: 0.3});
        canvas.height = viewport.height; 
        canvas.width = viewport.width;
        await page.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
        const cover = canvas.toDataURL();
        const book = books.find(b => b.name === fileName);
        if(book) { book.cover = cover; renderGrid(); }
        saveBookData(fileName, { cover });
    } catch (e) {
        console.error("PDF Cover error:", e);
    }
}

async function generateEPUBCover(file, fileName) {
    try {
        const book = ePub(file);
        const coverUrl = await book.coverUrl();
        if (coverUrl) {
            const response = await fetch(coverUrl);
            const blob = await response.blob();
            const reader = new FileReader();
            reader.onloadend = () => {
                const cover = reader.result;
                const book = books.find(b => b.name === fileName);
                if (book) { book.cover = cover; renderGrid(); }
                saveBookData(fileName, { cover });
            };
            reader.readAsDataURL(blob);
        }
    } catch (e) {
        console.error("EPUB Cover error:", e);
    }
}

async function generateCBZCover(file, fileName) {
    try {
        const zip = await JSZip.loadAsync(file);
        const imageFile = Object.keys(zip.files)
            .filter(name => /\.(jpg|jpeg|png|webp)$/i.test(name))
            .sort()[0];

        if (imageFile) {
            const blob = await zip.files[imageFile].async("blob");
            const reader = new FileReader();
            reader.onloadend = () => {
                const cover = reader.result;
                const book = books.find(b => b.name === fileName);
                if (book) { book.cover = cover; renderGrid(); }
                saveBookData(fileName, { cover });
            };
            reader.readAsDataURL(blob);
        }
    } catch (e) {
        console.error("CBZ Cover error:", e);
    }
}

function cleanupCBZ() { 
    cbzUrls.forEach(url => URL.revokeObjectURL(url)); 
    cbzUrls = []; 
}

function updateProgress(book) {
    if (book.locations && book.locations.length() > 0 && currentRendition && currentRendition.location) {
        const percent = Math.floor(book.locations.percentageFromCfi(currentRendition.location.start.cfi) * 100);
        const slider = document.getElementById('epub-slider');
        if (slider) slider.value = percent;
        const percentEl = document.getElementById('epub-percent');
        if (percentEl) percentEl.innerText = percent + "%";
    }
}

function prevPage() { 
    if (currentRendition) currentRendition.prev(); 
}

function nextPage() { 
    if (currentRendition) currentRendition.next(); 
}

async function deleteNote(i) { 
    const b = books.find(x => x.id === activeBookId); 
    if (!b) return;
    b.notes.splice(i, 1); 
    await saveBookData(b.name, { notes: b.notes }); 
    renderNotes(); 
}

async function addTag(id) { 
    const b = books.find(x => x.id === id); 
    if (!b) return;
    const t = prompt("Label name:"); 
    if (t && t.trim()) { 
        b.tags.push(t.trim()); 
        await saveBookData(b.name, { tags: b.tags }); 
        renderGrid(); 
    } 
}

async function removeTagByIndex(id, i) { 
    const b = books.find(x => x.id === id); 
    if (!b) return;
    b.tags.splice(i, 1); 
    await saveBookData(b.name, { tags: b.tags }); 
    renderGrid(); 
}

// --- UI AND GRID LOGIC ---
function renderGrid() {
    const grid = document.getElementById('grid');
    if (!grid) return;
    const s = (document.getElementById('search')?.value || '').toLowerCase();
    const sortVal = document.getElementById('sort')?.value || 'name';
    
    if (books.length === 0) {
        grid.className = "row";
        grid.innerHTML = `
            <div class="col-12">
                <div class="p-5 text-center bg-white rounded shadow-sm border">
                    <div class="mb-3" style="font-size: 3rem;">📚</div>
                    <h4 class="fw-bold mb-2">Welcome to RELIC</h4>
                    <p class="text-muted max-w-md mx-auto mb-4" style="max-width: 540px;">
                        Your research library companion. Read PDFs, EPUBs with <strong>Two-Page Spread & Separate Cover</strong> support, and CBZ comics with location-linked notes.
                    </p>
                    <div class="d-flex justify-content-center gap-2 flex-wrap">
                        <button class="btn btn-info text-white fw-bold px-4 shadow-sm" onclick="initFiles()">
                            <i data-lucide="file-plus" class="me-1"></i> Add Files (.pdf, .epub, .cbz)
                        </button>
                        <button class="btn btn-outline-primary fw-bold px-4 shadow-sm" onclick="initLibrary()">
                            <i data-lucide="folder-plus" class="me-1"></i> Add Local Folder
                        </button>
                    </div>
                </div>
            </div>
        `;
        if (window.lucide) lucide.createIcons();
        return;
    }

    let filtered = books.filter(b => 
        b.name.toLowerCase().includes(s) || 
        b.tags.some(t => t.toLowerCase().includes(s)) || 
        b.notes.some(n => n.text.toLowerCase().includes(s))
    );
    
    filtered.sort((a, b) => {
        if (sortVal === 'size') return b.size - a.size;
        if (sortVal === 'date') return b.date - a.date;
        if (sortVal === 'type') return a.type.localeCompare(b.type);
        if (sortVal === 'pages') return b.pages - a.pages;
        return a.name.localeCompare(b.name);
    });

    if (filtered.length === 0) {
        grid.className = "row";
        grid.innerHTML = `
            <div class="col-12 text-center py-5 text-muted">
                <i data-lucide="search-x" class="mb-2" style="width:36px; height:36px;"></i>
                <p>No documents found matching "${escapeHtml(s)}".</p>
            </div>
        `;
        if (window.lucide) lucide.createIcons();
        return;
    }

    if (currentView === 'list') {
        grid.className = "row row-cols-1 g-2"; 
        grid.innerHTML = filtered.map(b => `
            <div class="col">
                <div class="book-peek p-2 d-flex align-items-center gap-3 shadow-sm bg-white rounded border" onclick="openBook('${b.id}')">
                    <div style="width: 45px; height: 55px; flex-shrink: 0; background:#f0f2f5; display:flex; align-items:center; justify-content:center;" class="rounded overflow-hidden">
                        ${b.cover ? `<img src="${b.cover}" class="cover-img">` : `<i data-lucide="file-text" class="text-secondary"></i>`}
                    </div>
                    <div class="flex-grow-1 min-w-0">
                        <div class="fw-bold small text-truncate">${escapeHtml(b.name)}</div>
                        <div class="text-muted" style="font-size: 0.72rem;">
                            <span class="badge bg-${b.type === 'epub' ? 'warning text-dark' : (b.type === 'pdf' ? 'danger' : 'info')} me-1">${b.type.toUpperCase()}</span>
                            ${(b.size / 1024).toFixed(1)} KB • ${b.pages || 0} Pages
                        </div>
                        <div class="mt-1">${b.tags.map((t, i) => `<span class="tag-pill">${escapeHtml(t)}<span class="tag-remove" onclick="event.stopPropagation(); removeTagByIndex('${b.id}', ${i})">&times;</span></span>`).join('')}</div>
                    </div>
                    <div class="text-muted small text-end pe-2">
                        <div>Accessed</div>
                        <div style="font-size: 0.7rem;">${b.lastAccessed || 'N/A'}</div>
                    </div>
                </div>
            </div>
        `).join('');
    } else {
        grid.className = "row row-cols-1 row-cols-sm-2 row-cols-md-4 row-cols-lg-5 g-4";
        grid.innerHTML = filtered.map(b => `
            <div class="col">
                <div class="book-card shadow-sm">
                    <div class="cover-box" onclick="openBook('${b.id}')">
                        ${b.cover ? `<img src="${b.cover}" class="cover-img">` : `<i data-lucide="book" style="color:#bdc3c7; width:48px; height:48px;"></i>`}
                    </div>
                    <div class="p-2 flex-grow-1">
                        <div class="fw-bold text-truncate small mb-1" title="${escapeHtml(b.name)}">${escapeHtml(b.name)}</div>
                        <div class="text-muted mb-1" style="font-size: 0.7rem;">
                            <span class="badge bg-${b.type === 'epub' ? 'warning text-dark' : (b.type === 'pdf' ? 'danger' : 'info')} me-1">${b.type.toUpperCase()}</span>
                            ${b.pages || 0} Pages
                        </div>
                        <div>${b.tags.map((t, i) => `<span class="tag-pill">${escapeHtml(t)}<span class="tag-remove" onclick="event.stopPropagation(); removeTagByIndex('${b.id}', ${i})">&times;</span></span>`).join('')}</div>
                    </div>
                    <div class="p-2 border-top text-center"><button class="btn btn-link btn-sm p-0 text-decoration-none" onclick="addTag('${b.id}')">+ Label</button></div>
                </div>
            </div>
        `).join('');
    }
    if (window.lucide) lucide.createIcons();
}

// --- BACKUP AND CACHE MANAGEMENT ---
async function exportData() {
    if (!db) return;
    const trans = db.transaction(["books", "folders"], "readonly");
    const bData = await new Promise(r => trans.objectStore("books").getAll().onsuccess = e => r(e.target.result));
    const fData = await new Promise(r => trans.objectStore("folders").getAll().onsuccess = e => r(e.target.result));
    const blob = new Blob([JSON.stringify({ books: bData, folders: (fData || []).map(f => ({...f, handle: null})) })], { type: "application/json" });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `relic_backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    showToast('Backup downloaded successfully', 'success');
}

function triggerImport() { 
    const el = document.getElementById('import-file');
    if (el) el.click(); 
}

async function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            if (!db) return;
            const trans = db.transaction(["books", "folders"], "readwrite");
            if (Array.isArray(data.books)) data.books.forEach(b => trans.objectStore("books").put(b));
            if (Array.isArray(data.folders)) data.folders.forEach(f => trans.objectStore("folders").put(f));
            trans.oncomplete = () => {
                showToast('Import successful! Re-indexing...', 'success');
                setTimeout(() => location.reload(), 800);
            };
        } catch (err) {
            console.error("Invalid backup file:", err);
            showToast('Invalid backup file JSON.', 'danger');
        }
    };
    reader.readAsText(file);
}

function clearCache() { 
    indexedDB.deleteDatabase("LibraryCache"); 
    showToast('Cache cleared. Reloading...', 'warning');
    setTimeout(() => location.reload(), 500);
}

// Initial render
document.addEventListener('DOMContentLoaded', () => {
    updateEpubControlUI();
    renderGrid();
    if (window.lucide) lucide.createIcons();
});