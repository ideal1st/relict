pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

let books = [];
let activeBookId = null;
let db;
let currentURL = null;
let recentFolders = [];
let cbzUrls = []; 
let currentRendition; 
let currentView = 'grid'; 

// --- UNIVERSAL TRACKING OBSERVER ---
const observerOptions = {
    root: null, // Relative to viewport if not specified
    threshold: 0.5 
};

const pageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const pageNum = entry.target.dataset.page;
            const type = entry.target.dataset.type;
            
            if (type === 'cbz') {
                document.getElementById('note-location').value = `Img ${pageNum}`;
                document.getElementById('note-cfi').value = parseInt(pageNum) - 1; // 0-indexed for jumping
            } else if (type === 'pdf') {
                document.getElementById('note-location').value = `Page ${pageNum}`;
                document.getElementById('note-cfi').value = pageNum;
            }
        }
    });
}, observerOptions);

function setView(viewType) {
    currentView = viewType;
    document.getElementById('view-grid').classList.toggle('active', viewType === 'grid');
    document.getElementById('view-list').classList.toggle('active', viewType === 'list');
    renderGrid();
}

// --- DB CORE ---
const request = indexedDB.open("LibraryCache", 4);
request.onupgradeneeded = e => {
    const d = e.target.result;
    if (!d.objectStoreNames.contains("books")) d.createObjectStore("books", { keyPath: "name" });
    if (!d.objectStoreNames.contains("folders")) d.createObjectStore("folders", { keyPath: "name" });
};
request.onsuccess = e => { db = e.target.result; loadRecentFolders(); };

async function loadRecentFolders() {
    const trans = db.transaction("folders", "readonly");
    const req = trans.objectStore("folders").getAll();
    req.onsuccess = () => { recentFolders = req.result || []; renderFolderList(); };
}

async function saveFolderToDB(folderObj) {
    const trans = db.transaction("folders", "readwrite");
    trans.objectStore("folders").put(folderObj);
}

function toggleDrawer() {
    document.getElementById('drawer').classList.toggle('open');
    document.getElementById('drawer-overlay').classList.toggle('open');
}

function renderFolderList() {
    const list = document.getElementById('folder-list');
    if (recentFolders.length === 0) { list.innerHTML = '<p class="text-muted small text-center mt-3">Empty history.</p>'; return; }
    list.innerHTML = recentFolders.sort((a,b) => b.pinned - a.pinned || b.lastOpened - a.lastOpened).slice(0, 10).map((f, i) => `
        <div class="folder-item">
            <div class="text-truncate flex-grow-1 small fw-bold" onclick="reconnectFolder('${f.name}')">
                <i data-lucide="folder" class="me-2 text-warning" style="width:14px"></i> ${f.name}
            </div>
            <i data-lucide="pin" class="${f.pinned ? 'pinned-icon' : 'text-muted'}" style="width:16px; cursor:pointer" onclick="togglePin('${f.name}')"></i>
        </div>
    `).join('');
    lucide.createIcons();
}

async function togglePin(name) {
    const f = recentFolders.find(x => x.name === name);
    f.pinned = !f.pinned;
    await saveFolderToDB(f);
    renderFolderList();
}

async function reconnectFolder(name) {
    const folder = recentFolders.find(f => f.name === name);
    try {
        if (await folder.handle.requestPermission({ mode: 'read' }) === 'granted') {
            processFolder(folder.handle);
            toggleDrawer();
        }
    } catch (e) {
        const handle = await window.showDirectoryPicker();
        processFolder(handle);
    }
}

async function processFolder(handle) {
    const folderData = { name: handle.name, handle: handle, lastOpened: Date.now(), pinned: false };
    const existing = recentFolders.find(f => f.name === handle.name);
    if (existing) folderData.pinned = existing.pinned;
    await saveFolderToDB(folderData);
    loadRecentFolders();
    books = [];
    document.getElementById('grid').innerHTML = '<div class="text-center w-100 py-5"><div class="spinner-border text-primary"></div><p class="mt-2">Indexing files...</p></div>';
    for await (const entry of handle.values()) {
        if (entry.kind === 'file') {
            const file = await entry.getFile();
            const ext = file.name.split('.').pop().toLowerCase();
            if (['pdf', 'epub', 'cbz'].includes(ext)) {
                const stored = await getStoredBookData(file.name);
                let pageCount = 0;
                if (ext === 'pdf') {
                    try {
                        const pdfData = await file.arrayBuffer();
                        const pdf = await pdfjsLib.getDocument({data: pdfData}).promise;
                        pageCount = pdf.numPages;
                    } catch (e) { console.warn("Metadata skip:", file.name); }
                }
                books.push({
                    id: Math.random().toString(36).substr(2, 9),
                    name: file.name, blob: file, size: file.size, date: file.lastModified, type: ext,
                    pages: pageCount, lastAccessed: new Date().toLocaleString(),
                    cover: stored ? stored.cover : null, tags: stored ? (stored.tags || []) : [], notes: stored ? (stored.notes || []) : []
                });
                renderGrid();
                if (!stored?.cover && ext === 'pdf') generatePDFCover(file, file.name);
            }
        }
    }
}

async function getStoredBookData(name) {
    return new Promise(r => {
        const trans = db.transaction("books", "readonly");
        const req = trans.objectStore("books").get(name);
        req.onsuccess = () => r(req.result || null);
    });
}

async function saveBookData(name, newData) {
    const existing = await getStoredBookData(name) || { name, tags: [], cover: null, notes: [] };
    const updated = { ...existing, ...newData };
    db.transaction("books", "readwrite").objectStore("books").put(updated);
}

async function generatePDFCover(file, fileName) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
        const page = await pdf.getPage(1);
        const canvas = document.createElement('canvas');
        const viewport = page.getViewport({scale: 0.3});
        canvas.height = viewport.height; canvas.width = viewport.width;
        await page.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
        const cover = canvas.toDataURL();
        const book = books.find(b => b.name === fileName);
        if(book) { book.cover = cover; renderGrid(); }
        saveBookData(fileName, { cover });
    } catch (e) {}
}

function renderGrid() {
    const grid = document.getElementById('grid');
    const s = document.getElementById('search').value.toLowerCase();
    const sortVal = document.getElementById('sort').value;
    let filtered = books.filter(b => b.name.toLowerCase().includes(s) || b.tags.some(t => t.toLowerCase().includes(s)) || b.notes.some(n => n.text.toLowerCase().includes(s)));
    filtered.sort((a, b) => {
        if (sortVal === 'size') return b.size - a.size;
        if (sortVal === 'date') return b.date - a.date;
        if (sortVal === 'type') return a.type.localeCompare(b.type); 
        if (sortVal === 'pages') return b.pages - a.pages; 
        return a.name.localeCompare(b.name);
    });
    
    grid.className = currentView === 'list' ? "row row-cols-1 g-2" : "row row-cols-1 row-cols-sm-2 row-cols-md-4 row-cols-lg-5 g-4";
    grid.innerHTML = filtered.map(b => {
        if (currentView === 'list') {
            return `<div class="col"><div class="book-peek p-2 d-flex align-items-center gap-3 shadow-sm" onclick="openBook('${b.id}')"><div style="width: 40px; height: 50px; flex-shrink: 0;">${b.cover ? `<img src="${b.cover}" class="cover-img rounded">` : `<i data-lucide="file-text"></i>`}</div><div class="flex-grow-1"><div class="fw-bold small">${b.name}</div><div class="text-muted" style="font-size: 0.7rem;">${b.type.toUpperCase()} • ${(b.size / 1024).toFixed(1)} KB • ${b.pages} Pages</div><div>${b.tags.map((t, i) => `<span class="tag-pill">${t}</span>`).join('')}</div></div><div class="text-muted small">Accessed: ${b.lastAccessed || 'N/A'}</div></div></div>`;
        } else {
            return `<div class="col"><div class="book-card shadow-sm"><div class="cover-box" onclick="openBook('${b.id}')">${b.cover ? `<img src="${b.cover}" class="cover-img">` : `<i data-lucide="book" style="color:#bdc3c7"></i>`}</div><div class="p-2 flex-grow-1"><div class="fw-bold text-truncate small mb-1" title="${b.name}">${b.name}</div><div>${b.tags.map((t, i) => `<span class="tag-pill">${t}</span>`).join('')}</div></div><div class="p-2 border-top text-center"><button class="btn btn-link btn-sm p-0 text-decoration-none" onclick="addTag('${b.id}')">+ Label</button></div></div></div>`;
        }
    }).join('');
    lucide.createIcons();
}

// --- RENDER ENGINES ---

async function renderPDFMobile(blob, pageNum = 1) {
    const canvas = document.getElementById('pdf-canvas');
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    const url = URL.createObjectURL(blob);
    const pdf = await pdfjsLib.getDocument(url).promise;
    const page = await pdf.getPage(pageNum);
    
    // Direct Update
    document.getElementById('note-location').value = `Page ${pageNum}`;
    document.getElementById('note-cfi').value = pageNum;

    const viewport = page.getViewport({ scale: 1.5 });
    canvas.height = viewport.height; canvas.width = viewport.width;
    await page.render({ canvasContext: context, viewport: viewport }).promise;
    URL.revokeObjectURL(url);
}

function renderEPUB(blob) {
    if (typeof ePub === 'undefined') return alert("Loading EPUB engine...");
    const container = document.getElementById('epub-viewer');
    container.innerHTML = '';
    const book = ePub(blob);
    currentRendition = book.renderTo("epub-viewer", { width: "100%", height: "100%", flow: "scrolled-doc" });
    
    book.ready.then(() => book.locations.generate(150)).then(() => updateProgress(book));
    
    currentRendition.on("relocated", (location) => {
        const percent = Math.floor(book.locations.percentageFromCfi(location.start.cfi) * 100);
        document.getElementById('note-location').value = percent + "%";
        document.getElementById('note-cfi').value = location.start.cfi;
        updateProgress(book);
    });
    currentRendition.display();
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
        img.dataset.type = 'cbz';
        container.appendChild(img);
        pageObserver.observe(img); // START TRACKING
    }
}

// --- READER DISPATCH ---
function openBook(id) {
    activeBookId = id; 
    const b = books.find(x => x.id === id);
    const viewers = {
        pdf: document.getElementById('viewer'),
        canvas: document.getElementById('pdf-canvas'),
        epub: document.getElementById('epub-viewer'),
        cbz: document.getElementById('cbz-viewer')
    };
    
    // RESET TRACKING
    document.getElementById('note-location').value = '';
    document.getElementById('note-cfi').value = '';
    document.getElementById('epub-controls').style.display = (b.type === 'epub') ? 'block' : 'none';
    
    Object.values(viewers).forEach(el => el.style.display = 'none');
    document.getElementById('reader-overlay').style.display = 'block';
    document.getElementById('reading-title').innerText = b.name;

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (b.type === 'pdf') {
        if (isMobile) {
            viewers.canvas.style.display = 'block';
            renderPDFMobile(b.blob);
        } else {
            viewers.pdf.style.display = 'block';
            if (currentURL) URL.revokeObjectURL(currentURL);
            currentURL = URL.createObjectURL(b.blob);
            viewers.pdf.src = currentURL;
            // Desktop PDF Tracking fallback
            document.getElementById('note-location').value = "Page 1";
            document.getElementById('note-cfi').value = "1";
        }
    } else if (b.type === 'epub') {
        viewers.epub.style.display = 'block';
        renderEPUB(b.blob);
    } else if (b.type === 'cbz') {
        viewers.cbz.style.display = 'block';
        renderCBZ(b.blob);
    }
    renderNotes();
}

function closeReader() {
    document.getElementById('reader-overlay').style.display = 'none';
    document.getElementById('viewer').src = '';
    pageObserver.disconnect(); // STOP TRACKING
    cleanupCBZ();
}

function updateProgress(book) {
    if (book.locations.length() > 0 && currentRendition.location) {
        const percent = Math.floor(book.locations.percentageFromCfi(currentRendition.location.start.cfi) * 100);
        const slider = document.getElementById('epub-slider');
        if(slider) slider.value = percent;
        document.getElementById('epub-percent').innerText = percent + "%";
    }
}

function renderNotes() {
    const b = books.find(x => x.id === activeBookId);
    const list = document.getElementById('notes-list');
    const query = document.getElementById('note-search').value.toLowerCase();
    if (!b || !b.notes) return;

    list.innerHTML = b.notes.filter(n => n.text.toLowerCase().includes(query)).map((n, i) => `
        <div class="mb-3 p-2 border rounded bg-light small position-relative">
            <span class="badge bg-primary cursor-pointer mb-2" onclick="jumpToLocation('${n.value || n.page}')">
                ${n.display || (n.page ? 'Page '+n.page : 'Note')}
            </span>
            <div class="text-dark">${n.text}</div>
            <button class="btn btn-xs btn-link text-danger p-0" style="position:absolute; top:2px; right:8px" onclick="deleteNote(${i})">&times;</button>
        </div>
    `).join('');
}

async function addNote() {
    const b = books.find(x => x.id === activeBookId);
    const loc = document.getElementById('note-location').value;
    const val = document.getElementById('note-cfi').value;
    const txt = document.getElementById('note-text').value;
    if (txt) {
        b.notes.push({ display: loc, value: val, text: txt });
        await saveBookData(b.name, { notes: b.notes });
        document.getElementById('note-text').value = '';
        renderNotes();
    }
}

async function jumpToLocation(val) {
    const b = books.find(x => x.id === activeBookId);
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (b.type === 'epub' && currentRendition) currentRendition.display(val);
    else if (b.type === 'pdf') {
        if (isMobile) renderPDFMobile(b.blob, parseInt(val));
        else document.getElementById('viewer').src = currentURL + '#page=' + val;
    } else if (b.type === 'cbz') {
        const imgs = document.querySelectorAll('.cbz-page');
        if (imgs[val]) imgs[val].scrollIntoView({ behavior: 'smooth' });
    }
}

// Global UI helpers
async function deleteNote(i) { const b = books.find(x => x.id === activeBookId); b.notes.splice(i, 1); await saveBookData(b.name, { notes: b.notes }); renderNotes(); }
function cleanupCBZ() { cbzUrls.forEach(url => URL.revokeObjectURL(url)); cbzUrls = []; }
function prevPage() { if (currentRendition) currentRendition.prev(); }
function nextPage() { if (currentRendition) currentRendition.next(); }
async function addTag(id) { const b = books.find(x => x.id === id); const t = prompt("Label:"); if (t) { b.tags.push(t); await saveBookData(b.name, { tags: b.tags }); renderGrid(); } }
async function removeTagByIndex(id, i) { const b = books.find(x => x.id === id); b.tags.splice(i, 1); await saveBookData(b.name, { tags: b.tags }); renderGrid(); }
async function exportData() { /* Existing export logic */ }
function triggerImport() { document.getElementById('import-file').click(); }
async function importData(e) { /* Existing import logic */ }
function clearCache() { if(confirm("Clear data?")) { indexedDB.deleteDatabase("LibraryCache"); location.reload(); } }