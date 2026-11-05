/* Format Converter: uploads, page edits, context menu, and export. */

const $ = (id) => document.getElementById(id);

const state = {
  job: null,
  selectedId: null,
  cropMode: false,
  crop: null,
  cropDrag: null,
  placeNote: false,
  menuPageId: null,
  editSeq: 0,
  pending: null,
  baked: {},
  filmSig: '',
  stageToken: '',
  toolsPageId: null,
  pollTimer: null,
  lang: 'en',
};

const fileInput = $('file-input');
const menu = $('menu');

initTheme();
initLang();
bindChrome();
render();

function initTheme() {
  const saved = localStorage.getItem('fc-theme') || localStorage.getItem('ttif-theme');
  const dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
  $('theme-icon').textContent = dark ? '☾' : '☀';
}

function initLang() {
  const saved = localStorage.getItem('fc-lang');
  const browserArabic = (navigator.language || '').toLowerCase().startsWith('ar');
  state.lang = saved === 'ar' || saved === 'en' ? saved : (browserArabic ? 'ar' : 'en');
  applyI18n(state.lang);
  syncExportMode();
}

function setLang(lang) {
  state.lang = lang === 'ar' ? 'ar' : 'en';
  localStorage.setItem('fc-lang', state.lang);
  $('recent').hidden = true;
  applyI18n(state.lang);
  state.filmSig = '';
  state.stageToken = '';
  state.toolsPageId = null;
  render();
  syncExportMode();
}

function bindChrome() {
  $('theme-btn').addEventListener('click', () => {
    const dark = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('fc-theme', dark ? 'dark' : 'light');
    $('theme-icon').textContent = dark ? '☾' : '☀';
  });

  document.querySelectorAll('[data-lang]').forEach((button) => {
    button.addEventListener('click', () => setLang(button.dataset.lang));
  });

  $('browse-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    fileInput.click();
  });
  $('add-btn').addEventListener('click', () => fileInput.click());
  $('dropzone').addEventListener('click', () => fileInput.click());
  $('dropzone').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) uploadFiles(fileInput.files);
    fileInput.value = '';
  });

  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    document.body.classList.add('dropping');
    $('dropzone').classList.toggle('is-over', !$('hero').hidden);
  });
  window.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) {
      document.body.classList.remove('dropping');
      $('dropzone').classList.remove('is-over');
    }
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    document.body.classList.remove('dropping');
    $('dropzone').classList.remove('is-over');
    if (event.dataTransfer.files.length) uploadFiles(event.dataTransfer.files);
  });

  $('recent-btn').addEventListener('click', toggleRecent);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.recent-wrap')) $('recent').hidden = true;
    if (!event.target.closest('.menu')) closeMenu();
  });

  $('export-btn').addEventListener('click', openExport);
  $('export-cancel').addEventListener('click', () => $('export-dialog').close());
  $('export-form').addEventListener('submit', (event) => {
    event.preventDefault();
    runExport();
  });
  $('export-quality').addEventListener('input', () => {
    $('quality-val').textContent = $('export-quality').value;
  });
  $('export-format').addEventListener('change', syncExportMode);
  $('discard-btn').addEventListener('click', discardJob);

  $('stage').addEventListener('contextmenu', (event) => {
    if (!selected()) return;
    event.preventDefault();
    openMenu(event, selected().id);
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      if (state.cropMode) {
        state.cropMode = false;
        state.stageToken = '';
        render();
      }
      state.placeNote = false;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (typing || !selected()) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removePage(selected().id);
    } else if (event.key === 'r' || event.key === 'R') {
      rotatePage(selected().id, 90);
    } else if (event.key === 'ArrowRight') selectBy(1);
    else if (event.key === 'ArrowLeft') selectBy(-1);
  });

  window.addEventListener('pointermove', onCropMove);
  window.addEventListener('pointerup', onCropUp);
}

function hasFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes('Files');
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const url = state.job ? `/api/jobs/${state.job.id}/files` : '/api/jobs';
  const bar = $('progress');
  const fill = $('progress-bar');
  bar.hidden = false;
  fill.style.width = '4%';
  try {
    const body = await sendFiles(url, files, (ratio) => {
      fill.style.width = `${Math.round(ratio * 100)}%`;
    });
    bar.hidden = true;
    adopt(body.job, { replaceEdits: true });
    toast(state.lang === 'ar'
      ? `تمت إضافة ${files.length} ${countForm(files.length, 'ar', 'file')}`
      : `Added ${files.length} ${countForm(files.length, 'en', 'file')}`);
  } catch (err) {
    bar.hidden = true;
    toast(err.message);
  }
}

function sendFiles(url, files, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText || '{}'); } catch { /* keep empty */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || t('uploadFailed')));
    };
    xhr.onerror = () => reject(new Error(t('network')));
    const data = new FormData();
    for (const file of files) data.append('files', file);
    xhr.send(data);
  });
}

async function api(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || t('requestFailed'));
  return payload;
}

function adopt(job, { replaceEdits = false } = {}) {
  const fromServer = new Map(job.pages.map((page) => [page.id, structuredClone(page.edits)]));
  if (!replaceEdits && state.pending && state.pending.jobId === job.id) {
    const page = job.pages.find((item) => item.id === state.pending.pageId);
    if (page) page.edits = state.pending.edits;
  }
  for (const page of job.pages) {
    const known = state.baked[page.id];
    if (!known || known.revision !== page.revision) {
      state.baked[page.id] = { revision: page.revision, edits: fromServer.get(page.id) };
    }
  }
  const previous = state.selectedId;
  state.job = job;
  if (!job.pages.some((page) => page.id === previous)) state.selectedId = job.pages[0]?.id || null;
  render();
}

function selected() {
  return state.job?.pages.find((page) => page.id === state.selectedId) || null;
}

function render() {
  const job = state.job;
  const hasPages = Boolean(job?.pages.length);
  $('hero').hidden = hasPages;
  $('studio').hidden = !hasPages;
  $('dock').hidden = !hasPages;
  const notice = $('notice');
  if (job?.notice) {
    notice.hidden = false;
    notice.textContent = localize(job.notice);
  } else {
    notice.hidden = true;
  }
  if (!hasPages) {
    schedulePoll();
    return;
  }
  renderFilmstrip();
  renderStage();
  renderTools();
  const ready = job.pages.filter((page) => page.status === 'ready').length;
  const busy = job.pages.some((page) => page.status === 'processing');
  const pagesWord = countForm(job.pages.length, state.lang, 'page');
  $('dock-meta').textContent = `${job.pages.length} ${pagesWord} · ${ready} ${t('ready')}${busy ? ` · ${t('renderingShort')}` : ''}`;
  schedulePoll();
}

function renderFilmstrip() {
  const signature = `${state.lang}|` + state.job.pages.map((page) => `${page.id}:${page.status}:${page.revision}:${page.id === state.selectedId}`).join('|');
  if (signature === state.filmSig) return;
  state.filmSig = signature;
  const list = $('film');
  const scroll = list.scrollTop;
  list.replaceChildren();
  state.job.pages.forEach((page, index) => {
    const item = document.createElement('li');
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `card${page.id === state.selectedId ? ' selected' : ''}`;
    card.draggable = true;
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (page.previewUrl) {
      thumb.style.backgroundImage = `url("${page.previewUrl}")`;
    } else if (page.status === 'error') {
      thumb.textContent = '!';
    } else {
      const spin = document.createElement('span');
      spin.className = 'spin';
      thumb.appendChild(spin);
    }
    const copy = document.createElement('span');
    const title = document.createElement('b');
    title.textContent = `${index + 1}. ${page.label}`;
    const meta = document.createElement('small');
    meta.textContent = page.status === 'error' ? localize(page.error) : t(`source.${page.sourceType}`);
    copy.append(title, meta);
    card.append(thumb, copy);
    card.addEventListener('click', () => selectPage(page.id));
    card.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectPage(page.id);
      openMenu(event, page.id);
    });
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('application/x-ttif-page', page.id);
      event.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragover', (event) => {
      if (![...event.dataTransfer.types].includes('application/x-ttif-page')) return;
      event.preventDefault();
      const rect = card.getBoundingClientRect();
      const horizontal = window.innerWidth <= 980;
      const before = horizontal
        ? event.clientX < rect.left + rect.width / 2
        : event.clientY < rect.top + rect.height / 2;
      card.classList.toggle('drop-before', before);
      card.classList.toggle('drop-after', !before);
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drop-before', 'drop-after');
    });
    card.addEventListener('drop', (event) => {
      const id = event.dataTransfer.getData('application/x-ttif-page');
      card.classList.remove('drop-before', 'drop-after');
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = card.getBoundingClientRect();
      const horizontal = window.innerWidth <= 980;
      const before = horizontal
        ? event.clientX < rect.left + rect.width / 2
        : event.clientY < rect.top + rect.height / 2;
      reorderDrop(id, page.id, before);
    });
    item.appendChild(card);
    list.appendChild(item);
  });
  list.scrollTop = scroll;
}

function renderStage() {
  const page = selected();
  const token = `${page.id}:${page.revision}:${page.previewUrl ? 'img' : page.status}:${state.cropMode}:${state.placeNote}`;
  if (token === state.stageToken && !state.cropDrag) return;
  if (state.cropDrag) return;
  state.stageToken = token;
  const stage = $('stage');
  stage.replaceChildren();
  if (page.status === 'processing' && !page.previewUrl) {
    stage.appendChild(message(t('rendering')));
    return;
  }
  if (page.status === 'error') {
    stage.appendChild(message(localize(page.error) || t('unreadable')));
    return;
  }
  const frame = document.createElement('div');
  frame.className = `frame${state.placeNote ? ' placing' : ''}`;
  const img = document.createElement('img');
  img.alt = page.label;
  img.draggable = false;
  img.src = state.cropMode
    ? `/api/jobs/${state.job.id}/pages/${page.id}/preview?view=frame&v=${page.revision}`
    : page.previewUrl;
  img.addEventListener('load', () => {
    const stage = $('stage');
    const maxW = Math.max(120, stage.clientWidth - 36);
    const maxH = Math.max(120, stage.clientHeight - 36);
    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
    img.style.width = `${Math.max(1, Math.round(img.naturalWidth * scale))}px`;
    img.style.height = 'auto';
    img.style.filter = stageFilter(page);
  });
  frame.appendChild(img);
  if (state.cropMode) {
    state.crop = state.crop || page.edits.crop || { x: 0.08, y: 0.08, w: 0.84, h: 0.84 };
    frame.appendChild(cropBox());
  }
  frame.addEventListener('click', (event) => placeAnnotation(event, img));
  stage.appendChild(frame);
  img.style.filter = stageFilter(page);
}

function message(text) {
  const node = document.createElement('p');
  node.className = 'placeholder';
  node.textContent = text;
  return node;
}

function stageFilter(page) {
  const baked = state.baked[page.id]?.edits || page.edits;
  const brightness = 1 + ((page.edits.brightness || 0) - (baked.brightness || 0)) / 100;
  const contrast = 1 + ((page.edits.contrast || 0) - (baked.contrast || 0)) / 100;
  const parts = [];
  if (Math.abs(brightness - 1) > 0.001) parts.push(`brightness(${brightness})`);
  if (Math.abs(contrast - 1) > 0.001) parts.push(`contrast(${contrast})`);
  if (Boolean(page.edits.grayscale) !== Boolean(baked.grayscale) && page.edits.grayscale) parts.push('grayscale(1)');
  return parts.join(' ') || 'none';
}

function renderTools() {
  const page = selected();
  if (state.toolsPageId === page.id && $('tools').childElementCount) {
    syncTools(page);
    return;
  }
  state.toolsPageId = page.id;
  const root = $('tools');
  root.replaceChildren();
  if (page.status === 'error') {
    root.appendChild(message(localize(page.error)));
    return;
  }

  const rotate = block(t('rotation'));
  rotate.appendChild(buttonRow([
    [t('rotateLeft'), () => rotatePage(page.id, -90)],
    [t('rotateRight'), () => rotatePage(page.id, 90)],
    [t('grayscale'), () => patchLocal({ grayscale: !page.edits.grayscale })],
  ]));

  const tone = block(t('tone'));
  tone.append(
    slider(t('brightness'), 'brightness', -100, 100),
    slider(t('contrast'), 'contrast', -100, 100),
    buttonRow([[t('resetTone'), () => patchLocal({ brightness: 0, contrast: 0, grayscale: false })]])
  );

  const crop = block(t('crop'));
  crop.appendChild(buttonRow([
    [state.cropMode ? t('closeCrop') : t('cropImage'), toggleCrop],
    [t('applyCrop'), applyCrop],
    [t('clearCrop'), () => { state.cropMode = false; state.crop = null; patchLocal({ crop: null }); }],
  ]));

  const notes = block(t('notes'));
  const text = document.createElement('input');
  text.id = 'note-text';
  text.type = 'text';
  text.placeholder = t('notePlaceholder');
  text.maxLength = 180;
  const color = document.createElement('input');
  color.type = 'color';
  color.id = 'note-color';
  color.value = '#1c1917';
  notes.append(text, color, buttonRow([
    [state.placeNote ? t('placing') : t('placeNote'), () => {
      state.placeNote = !state.placeNote;
      state.stageToken = '';
      render();
    }],
  ]));
  const list = document.createElement('div');
  list.id = 'note-list';
  notes.appendChild(list);

  const pageTools = block(t('page'));
  pageTools.appendChild(buttonRow([
    [t('moveUp'), () => move(page.id, 'up')],
    [t('moveDown'), () => move(page.id, 'down')],
    [t('download'), () => downloadPreview(page.id)],
    [t('delete'), () => removePage(page.id)],
  ]));

  const keys = document.createElement('p');
  keys.className = 'keys';
  keys.textContent = t('keys');
  root.append(rotate, tone, crop, notes, pageTools, keys);
  syncTools(page);
}

function block(title) {
  const wrap = document.createElement('section');
  wrap.className = 'tool-block';
  const heading = document.createElement('h3');
  heading.textContent = title;
  wrap.appendChild(heading);
  return wrap;
}

function buttonRow(items) {
  const row = document.createElement('div');
  row.className = 'row';
  for (const [label, action] of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = label;
    button.addEventListener('click', action);
    row.appendChild(button);
  }
  return row;
}

function slider(label, key, min, max) {
  const wrap = document.createElement('label');
  const caption = document.createElement('span');
  caption.textContent = label;
  const value = document.createElement('span');
  value.id = `${key}-val`;
  caption.append(' ', value);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.id = `${key}-range`;
  input.addEventListener('input', () => {
    patchLocal({ [key]: Number(input.value) }, { debounce: true, silent: true });
    value.textContent = input.value;
    const image = $('stage').querySelector('img');
    const page = selected();
    if (image && page) image.style.filter = stageFilter(page);
  });
  wrap.append(caption, input);
  return wrap;
}

function syncTools(page) {
  const brightness = $('brightness-range');
  const contrast = $('contrast-range');
  if (brightness && document.activeElement !== brightness) brightness.value = page.edits.brightness;
  if (contrast && document.activeElement !== contrast) contrast.value = page.edits.contrast;
  const bv = $('brightness-val');
  const cv = $('contrast-val');
  if (bv) bv.textContent = page.edits.brightness;
  if (cv) cv.textContent = page.edits.contrast;
  const list = $('note-list');
  if (!list) return;
  list.replaceChildren();
  for (const note of page.edits.annotations) {
    const row = document.createElement('div');
    row.className = 'note';
    const text = document.createElement('span');
    text.textContent = note.text;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-btn';
    remove.textContent = t('remove');
    remove.addEventListener('click', () => {
      patchLocal({ annotations: page.edits.annotations.filter((item) => item.id !== note.id) });
    });
    row.append(text, remove);
    list.appendChild(row);
  }
}

function patchLocal(partial, { debounce = false, silent = false } = {}) {
  const page = selected();
  if (!page) return;
  if (partial.crop === null) page.edits.crop = null;
  page.edits = {
    ...page.edits,
    ...partial,
    annotations: partial.annotations || page.edits.annotations,
  };
  if (!silent) {
    state.stageToken = '';
    state.toolsPageId = null;
  }
  state.pending = { jobId: state.job.id, pageId: page.id, edits: structuredClone(page.edits), seq: state.editSeq };
  if (debounce) queueSave();
  else saveEdits();
  if (!silent) render();
}

let saveTimer = 0;
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveEdits, 280);
}

async function saveEdits() {
  const page = selected();
  if (!page || !state.job) return;
  const seq = ++state.editSeq;
  const edits = structuredClone(page.edits);
  state.pending = { jobId: state.job.id, pageId: page.id, edits, seq };
  try {
    const payload = await api(`/api/jobs/${state.job.id}/pages/${page.id}`, { method: 'PATCH', body: edits });
    if (seq !== state.editSeq) return;
    state.pending = null;
    adopt(payload.job);
  } catch (err) {
    if (seq === state.editSeq) toast(err.message);
  }
}

function rotatePage(id, delta) {
  selectPage(id);
  const page = selected();
  if (!page) return;
  const rotation = (page.edits.rotation + (delta < 0 ? 270 : 90)) % 360;
  const crop = page.edits.crop ? (delta < 0 ? rotateCropCCW(page.edits.crop) : rotateCropCW(page.edits.crop)) : null;
  if (state.cropMode) state.crop = crop || state.crop;
  patchLocal({ rotation, crop });
}

function rotateCropCW(crop) {
  return { x: 1 - crop.y - crop.h, y: crop.x, w: crop.h, h: crop.w };
}
function rotateCropCCW(crop) {
  return { x: crop.y, y: 1 - crop.x - crop.w, w: crop.h, h: crop.w };
}

function toggleCrop() {
  state.cropMode = !state.cropMode;
  state.crop = state.cropMode ? (selected()?.edits.crop || { x: 0.08, y: 0.08, w: 0.84, h: 0.84 }) : null;
  state.placeNote = false;
  state.stageToken = '';
  state.toolsPageId = null;
  render();
}

function applyCrop() {
  if (!state.crop) return;
  state.cropMode = false;
  const crop = { ...state.crop };
  state.crop = null;
  patchLocal({ crop });
}

function cropBox() {
  const box = document.createElement('div');
  box.className = 'crop-box';
  box.dataset.handle = 'move';
  placeCrop(box);
  for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const node = document.createElement('i');
    node.dataset.handle = handle;
    box.appendChild(node);
  }
  box.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const image = $('stage').querySelector('img');
    state.cropDrag = {
      handle: event.target.dataset.handle || 'move',
      start: pointOn(image, event),
      origin: { ...state.crop },
    };
  });
  return box;
}

function placeCrop(box = document.querySelector('.crop-box')) {
  if (!box || !state.crop) return;
  box.style.left = `${state.crop.x * 100}%`;
  box.style.top = `${state.crop.y * 100}%`;
  box.style.width = `${state.crop.w * 100}%`;
  box.style.height = `${state.crop.h * 100}%`;
}

function onCropMove(event) {
  if (!state.cropDrag) return;
  const image = $('stage').querySelector('img');
  if (!image) return;
  const point = pointOn(image, event);
  const dx = point.x - state.cropDrag.start.x;
  const dy = point.y - state.cropDrag.start.y;
  const origin = state.cropDrag.origin;
  const handle = state.cropDrag.handle;
  let { x, y, w, h } = origin;
  const min = 0.04;
  if (handle === 'move') {
    x = clamp(origin.x + dx, 0, 1 - origin.w);
    y = clamp(origin.y + dy, 0, 1 - origin.h);
  } else {
    if (handle.includes('e')) w = clamp(origin.w + dx, min, 1 - origin.x);
    if (handle.includes('s')) h = clamp(origin.h + dy, min, 1 - origin.y);
    if (handle.includes('w')) {
      x = clamp(origin.x + dx, 0, origin.x + origin.w - min);
      w = origin.w + (origin.x - x);
    }
    if (handle.includes('n')) {
      y = clamp(origin.y + dy, 0, origin.y + origin.h - min);
      h = origin.h + (origin.y - y);
    }
  }
  state.crop = { x, y, w, h };
  placeCrop();
}

function onCropUp() {
  state.cropDrag = null;
}

function pointOn(image, event) {
  const rect = image.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function placeAnnotation(event, image) {
  if (!state.placeNote || event.target.closest('.crop-box')) return;
  const text = $('note-text')?.value.trim();
  if (!text) {
    toast(t('noteFirst'));
    return;
  }
  const point = pointOn(image, event);
  const page = selected();
  const note = {
    id: Math.random().toString(16).slice(2, 10),
    text,
    x: point.x,
    y: point.y,
    size: 3.2,
    color: $('note-color')?.value || '#1c1917',
  };
  state.placeNote = false;
  patchLocal({ annotations: [...page.edits.annotations, note] });
}

function selectPage(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  state.cropMode = false;
  state.crop = null;
  state.placeNote = false;
  state.stageToken = '';
  state.toolsPageId = null;
  state.filmSig = '';
  render();
}

function selectBy(step) {
  const pages = state.job?.pages || [];
  const index = pages.findIndex((page) => page.id === state.selectedId);
  const next = pages[index + step];
  if (next) selectPage(next.id);
}

async function move(id, where) {
  const ids = state.job.pages.map((page) => page.id);
  const index = ids.indexOf(id);
  if (index < 0) return;
  ids.splice(index, 1);
  const dest = where === 'top' ? 0 : where === 'up' ? Math.max(0, index - 1) : Math.min(ids.length, index + 1);
  ids.splice(dest, 0, id);
  await sendOrder(ids);
}

async function reorderDrop(dragId, targetId, before) {
  if (dragId === targetId) return;
  const ids = state.job.pages.map((page) => page.id).filter((id) => id !== dragId);
  let index = ids.indexOf(targetId);
  if (!before) index += 1;
  ids.splice(index, 0, dragId);
  await sendOrder(ids);
}

async function sendOrder(order) {
  try {
    const payload = await api(`/api/jobs/${state.job.id}/order`, { method: 'PUT', body: { order } });
    state.filmSig = '';
    adopt(payload.job);
  } catch (err) {
    toast(err.message);
  }
}

async function removePage(id) {
  try {
    const payload = await api(`/api/jobs/${state.job.id}/pages/${id}`, { method: 'DELETE' });
    state.filmSig = '';
    state.stageToken = '';
    state.toolsPageId = null;
    adopt(payload.job, { replaceEdits: true });
  } catch (err) {
    toast(err.message);
  }
}

async function downloadPreview(id) {
  try {
    const response = await fetch(`/api/jobs/${state.job.id}/pages/${id}/download`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || t('downloadFailed'));
    }
    saveBlob(await response.blob(), filenameFrom(response.headers.get('Content-Disposition'), 'page.png'));
  } catch (err) {
    toast(err.message);
  }
}

function openMenu(event, pageId) {
  state.menuPageId = pageId;
  const items = [
    [t('cropImage'), 'crop'],
    [t('rotate90'), 'rotate'],
    [t('moveTop'), 'top'],
    [t('moveUp'), 'up'],
    [t('moveDown'), 'down'],
    [t('toggleGray'), 'gray'],
    [t('downloadPreview'), 'download'],
    [t('deletePage'), 'delete'],
  ];
  menu.replaceChildren();
  for (const [label, action] of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('role', 'menuitem');
    if (action === 'delete') button.className = 'danger';
    button.addEventListener('click', (click) => {
      click.stopPropagation();
      runMenu(action);
    });
    menu.appendChild(button);
  }
  menu.hidden = false;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 8)}px`;
}

function closeMenu() {
  menu.hidden = true;
}

function runMenu(action) {
  const id = state.menuPageId;
  closeMenu();
  if (!id) return;
  selectPage(id);
  if (action === 'crop') toggleCrop();
  else if (action === 'rotate') rotatePage(id, 90);
  else if (action === 'top') move(id, 'top');
  else if (action === 'up') move(id, 'up');
  else if (action === 'down') move(id, 'down');
  else if (action === 'gray') patchLocal({ grayscale: !selected().edits.grayscale });
  else if (action === 'download') downloadPreview(id);
  else if (action === 'delete') removePage(id);
}

function openExport() {
  syncExportMode();
  $('export-dialog').showModal();
}

function syncExportMode() {
  const format = $('export-format').value;
  const mode = $('export-mode');
  const singleOnly = format === 'png' || format === 'jpeg' || format === 'webp';
  mode.options[0].textContent = format === 'tiff' ? t('multiTiff') : format === 'pdf' ? t('onePdf') : t('oneFile');
  mode.options[0].disabled = singleOnly && (state.job?.pages.length || 0) > 1;
  if (mode.options[0].disabled) mode.value = 'separate';
}

async function runExport() {
  const button = $('export-form').querySelector('[type="submit"]');
  button.disabled = true;
  button.textContent = t('building');
  const pagesValue = $('export-pages').value.trim();
  const body = {
    filename: $('export-name').value,
    format: $('export-format').value,
    mode: $('export-mode').value,
    pages: !pagesValue || pagesValue === 'all' || pagesValue === 'الكل' ? 'all' : pagesValue,
    quality: Number($('export-quality').value),
    watermark: { text: $('export-watermark').value.trim(), opacity: 0.16 },
  };
  try {
    const response = await fetch(`/api/jobs/${state.job.id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || t('exportFailed'));
    }
    const blob = await response.blob();
    saveBlob(blob, filenameFrom(response.headers.get('Content-Disposition'), 'export'));
    $('export-dialog').close();
    toast(t('exportReady'));
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
    button.textContent = t('build');
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function filenameFrom(header, fallback) {
  const star = header?.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) return decodeURIComponent(star[1]);
  const plain = header?.match(/filename="([^"]+)"/);
  return plain?.[1] || fallback;
}

async function discardJob() {
  const dialog = $('confirm-dialog');
  dialog.showModal();
  const choice = await new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
  });
  if (choice !== 'ok' || !state.job) return;
  try {
    await api(`/api/jobs/${state.job.id}`, { method: 'DELETE' });
    state.job = null;
    state.selectedId = null;
    state.filmSig = '';
    state.stageToken = '';
    state.toolsPageId = null;
    render();
    toast(t('jobDiscarded'));
  } catch (err) {
    toast(err.message);
  }
}

async function toggleRecent() {
  const panel = $('recent');
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.textContent = t('loading');
  try {
    const payload = await api('/api/jobs');
    panel.replaceChildren();
    if (!payload.jobs.length) {
      panel.textContent = t('noJobs');
      return;
    }
    for (const job of payload.jobs) {
      const button = document.createElement('button');
      button.type = 'button';
      const title = document.createElement('strong');
      title.textContent = job.label;
      const meta = document.createElement('small');
      meta.textContent = `${job.pages} ${countForm(job.pages, state.lang, 'page')} · ${job.id}`;
      button.append(title, meta);
      button.addEventListener('click', () => openJob(job.id));
      panel.appendChild(button);
    }
  } catch (err) {
    panel.textContent = err.message;
  }
}

async function openJob(id) {
  $('recent').hidden = true;
  try {
    const payload = await api(`/api/jobs/${id}`);
    state.selectedId = payload.job.pages[0]?.id || null;
    state.filmSig = '';
    state.stageToken = '';
    state.toolsPageId = null;
    adopt(payload.job, { replaceEdits: true });
  } catch (err) {
    toast(err.message);
  }
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (state.job?.pages.some((page) => page.status === 'processing')) {
    state.pollTimer = setTimeout(refreshJob, 700);
  }
}

async function refreshJob() {
  if (!state.job) return;
  try {
    const payload = await api(`/api/jobs/${state.job.id}`);
    adopt(payload.job);
  } catch (err) {
    toast(err.message);
  }
}

function toast(message) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = localize(message);
  $('toasts').appendChild(node);
  setTimeout(() => node.remove(), 4200);
}
