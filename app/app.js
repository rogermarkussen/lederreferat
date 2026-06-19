import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const INDEX_VERSION = 4;
const TASK_DATA_VERSION = 1;
const STORAGE_INDEX_KEY = "lmReferatSearch.index.v4";
const STORAGE_FOLDER_KEY = "lmReferatSearch.folder.v4";
const DB_NAME = "lmReferatSearch";
const DB_STORE = "handles";
const DB_HANDLE_KEY = "referatFolder";
const TASK_DATA_DIR = "__oppgavedata__";
const TASK_DATA_FILE = "oppgaver.json";
const PDF_LINE_Y_TOLERANCE = 2;
const PDF_WORD_GAP_MIN = 1.2;
const PDF_WORD_GAP_FONT_RATIO = 0.16;

const CASE_RE = /^(?<number>[2-4]\.\d+)\s*[-–]?\s+(?<title>\S.+)$/;
const CASE_NUMBER_ONLY_RE = /^(?<number>[2-4]\.\d+)$/;
const EVENTUELT_RE = /^3\s+Eventuelt$/i;
const SIRK_RE = /^4\s+Sirkulasjonssaker$/i;
const INTRO_RE = /^1\.\d+\s+\S.+$/;
const AP_RE = /^(?<id>AP\d+-\d+)\s*:\s*(?<text>.*)$/i;
const LM_RE = /\bLM\s+(?<lm>\d+\/\d{4})\b/i;
const DATE_RE = /Møtedato:\s*(?<date>\d{1,2}\.\d{1,2}\.\d{4})/i;
const ARCHIVE_RE = /Saksnummer:\s*(?<number>\d+)/i;
const RESPONSIBLE_RE = /\bAnsvar(?:lig)?\s*:\s*(?<owner>.+)$/i;
const SECTION_HEADINGS = new Set([
  "vedtak",
  "oppfølging",
  "oppfølging:",
  "forslag til oppfølging",
  "forslag til oppfølging:",
]);
const STOP_HEADINGS = new Set(["sirkulasjonssaker", "agenda neste møte"]);

const state = {
  index: null,
  directoryHandle: null,
  view: "search",
  filter: "all",
  taskFilter: "open",
  taskOwners: new Set(),
  query: "",
  dateFrom: "",
  dateTo: "",
  busy: false,
};

const els = {
  viewTabs: [...document.querySelectorAll(".view-tab")],
  caseControls: document.querySelector("#case-controls"),
  taskControls: document.querySelector("#task-controls"),
  searchLabel: document.querySelector(".search-label"),
  chooseFolder: document.querySelector("#choose-folder"),
  reindexFolder: document.querySelector("#reindex-folder"),
  folderMeta: document.querySelector("#folder-meta"),
  search: document.querySelector("#search"),
  clear: document.querySelector("#clear-search"),
  dateFrom: document.querySelector("#date-from"),
  dateTo: document.querySelector("#date-to"),
  clearDates: document.querySelector("#clear-dates"),
  filters: [...document.querySelectorAll(".filter")],
  taskFilters: [...document.querySelectorAll(".task-filter")],
  taskOwnerFilter: document.querySelector("#task-owner-filter"),
  results: document.querySelector("#results"),
  resultTitle: document.querySelector("#result-title"),
  resultCount: document.querySelector("#result-count"),
  datasetMeta: document.querySelector("#dataset-meta"),
  status: document.querySelector("#status-pill"),
};

const collator = new Intl.Collator("no", { numeric: true, sensitivity: "base" });

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSpace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizePdfLine(text) {
  return normalizeSpace(text)
    .replace(/\b(AP\d+)\s*-\s*(\d+)\b/gi, "$1-$2")
    .replace(/\b(LM)\s+(\d+)\s*\/\s*(\d{2,3})\s*(\d)\b/gi, "$1 $2/$3$4")
    .replace(/\b(\d{1,2})\s*\.\s*(\d{2})\.(\d{4})\b/g, "$1.$2.$3")
    .replace(/\b(Saksnummer:\s*\d)\s+(\d{6})\b/gi, "$1$2")
    .replace(/\b(\d)\s*\.\s*(\d{2})\b/g, "$1.$2")
    .replace(/\bVirksomhet s\s*-\s*/g, "Virksomhets- ")
    .replace(/\s+\./g, ".");
}

function pdfItemEnd(item) {
  return item.x + Math.max(item.width || 0, 0);
}

function shouldInsertPdfSpace(previous, next) {
  if (!previous) return false;
  if (/^[,.;:!?%)\]\}»”]/.test(next.text)) return false;
  if (/[(\[\{«“]$/.test(previous.text)) return false;

  const gap = next.x - pdfItemEnd(previous);
  if (!Number.isFinite(gap)) return true;

  const fontSize = Math.min(previous.height || Infinity, next.height || Infinity);
  const fallbackFontSize = Math.max(previous.height || 0, next.height || 0, 10);
  const threshold = Math.max(
    PDF_WORD_GAP_MIN,
    (Number.isFinite(fontSize) ? fontSize : fallbackFontSize) * PDF_WORD_GAP_FONT_RATIO,
  );
  return gap > threshold;
}

function joinPdfLineItems(items) {
  let text = "";
  let previous = null;
  for (const item of items) {
    text += `${text && shouldInsertPdfSpace(previous, item) ? " " : ""}${item.text}`;
    previous = item;
  }
  return normalizePdfLine(text);
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(isoDate) {
  if (!isoDate) return "Ukjent dato";
  const [year, month, day] = isoDate.split("-");
  return `${day}.${month}.${year}`;
}

function isoDateFromDisplay(displayDate) {
  if (!displayDate) return null;
  const [day, month, year] = displayDate.split(".");
  if (!day || !month || !year) return null;
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function slug(text) {
  return normalize(text).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function tokenize(query) {
  const rawTerms = normalize(query)
    .split(/[^a-z0-9æøå]+/i)
    .map((term) => term.trim())
    .filter(Boolean);
  if (rawTerms.length === 1) return rawTerms;
  return rawTerms.filter((term) => term.length > 1);
}

function parseSearchQuery(query) {
  const exactPhrases = [];
  const remainder = String(query || "").replace(/"([^"]+)"/g, (_match, phrase) => {
    const normalized = normalize(phrase);
    if (normalized) exactPhrases.push(normalized);
    return " ";
  });
  const terms = tokenize(remainder);
  return {
    raw: String(query || "").trim(),
    terms,
    exactPhrases,
    freePhrase: normalize(remainder),
  };
}

function isSearchWordChar(character) {
  return /^[a-z0-9æøå]$/i.test(character || "");
}

function hasWholeWord(text, term) {
  if (!text || !term) return false;
  let index = text.indexOf(term);
  while (index >= 0) {
    const before = text[index - 1] || "";
    const after = text[index + term.length] || "";
    if (!isSearchWordChar(before) && !isSearchWordChar(after)) return true;
    index = text.indexOf(term, index + 1);
  }
  return false;
}

function matchesExactPhrases(searchText, parsedQuery) {
  if (!parsedQuery.exactPhrases.length) return true;
  return parsedQuery.exactPhrases.every((phrase) => searchText.includes(phrase));
}

function setStatus(text, busy = false) {
  state.busy = busy;
  els.status.textContent = text;
  els.chooseFolder.disabled = busy;
  els.reindexFolder.disabled = busy || !state.directoryHandle;
}

function setFolderMeta(text) {
  els.folderMeta.textContent = text;
}

function scrollToTopResult() {
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  });
}

function renderAfterUserChange() {
  render();
  scrollToTopResult();
}

function readLocalStorageJson(key) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeLocalStorageJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStoredDirectoryHandle() {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const request = tx.objectStore(DB_STORE).get(DB_HANDLE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function storeDirectoryHandle(handle) {
  const db = await openHandleDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(handle, DB_HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function ensureDirectoryPermission(handle, { request = true, mode = "read" } = {}) {
  if (!handle) return false;
  const options = { mode };
  if ((await handle.queryPermission(options)) === "granted") return true;
  if (!request) return false;
  return (await handle.requestPermission(options)) === "granted";
}

async function chooseDirectory() {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("Nettleseren støtter ikke mappevalg. Bruk Chrome eller Edge over HTTPS.");
  }
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  state.directoryHandle = handle;
  await storeDirectoryHandle(handle);
  writeLocalStorageJson(STORAGE_FOLDER_KEY, {
    name: handle.name,
    selectedAt: new Date().toISOString(),
  });
  setFolderMeta(`Valgt mappe: ${handle.name}`);
  await indexDirectory(handle);
}

async function listPdfFiles(handle) {
  const files = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind !== "file" || !name.toLowerCase().endsWith(".pdf")) continue;
    const file = await entry.getFile();
    files.push(file);
  }
  files.sort((a, b) => collator.compare(a.name, b.name));
  return files;
}

async function extractPdfLines(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const lines = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const items = textContent.items
      .map((item) => ({
        text: normalizeSpace(item.str),
        x: item.transform[4],
        y: item.transform[5],
        width: item.width || 0,
        height: item.height || 0,
      }))
      .filter((item) => item.text);
    items.sort((a, b) => {
      if (Math.abs(b.y - a.y) > PDF_LINE_Y_TOLERANCE) return b.y - a.y;
      return a.x - b.x;
    });
    let current = null;
    for (const item of items) {
      if (!current || Math.abs(current.y - item.y) > PDF_LINE_Y_TOLERANCE) {
        if (current) lines.push({ text: joinPdfLineItems(current.items), page: pageNumber });
        current = { y: item.y, items: [item] };
      } else {
        current.items.push(item);
      }
    }
    if (current) lines.push({ text: joinPdfLineItems(current.items), page: pageNumber });
  }
  await pdf.destroy();
  return lines;
}

function protocolStart(lines) {
  const index = lines.findIndex((line) => line.text === "Protokoll" || line.text.startsWith("Protokoll LM"));
  return index >= 0 ? index : 0;
}

function extractMetadata(lines, start) {
  const header = lines
    .slice(start, Math.min(start + 25, lines.length))
    .map((line) => line.text)
    .join("\n");
  let lmMatch = LM_RE.exec(header);
  if (!lmMatch) {
    for (let i = start; i < Math.min(start + 6, lines.length - 1); i += 1) {
      if (lines[i].text === "Protokoll LM" && /^\d+\/\d{4}$/.test(lines[i + 1].text)) {
        lmMatch = /(?<lm>\d+\/\d{4})/.exec(lines[i + 1].text);
        break;
      }
    }
  }
  const dateMatch = DATE_RE.exec(header);
  const archiveMatch = ARCHIVE_RE.exec(header);
  const meetingDateDisplay = dateMatch?.groups?.date || null;
  return {
    lm_number: lmMatch?.groups?.lm || null,
    meeting_date: isoDateFromDisplay(meetingDateDisplay),
    meeting_date_display: meetingDateDisplay,
    archive_case_number: archiveMatch?.groups?.number || null,
  };
}

function extractAgendaCases(lines, start) {
  const agenda = [];
  let pendingNumber = null;
  for (const line of lines.slice(0, start)) {
    const caseMatch = CASE_RE.exec(line.text);
    let number = null;
    let title = null;
    if (caseMatch) {
      number = caseMatch.groups.number;
      title = normalizeSpace(caseMatch.groups.title);
      pendingNumber = null;
    } else {
      const embeddedCaseMatch = /\b(?<number>[2-4]\.\d+)\s+(?<title>.+?)(?:\s+Avd\.|\s+Stab\.?|\s+KOM\b|\s+Dir\.|\s+Alle\b|$)/.exec(
        line.text,
      );
      if (embeddedCaseMatch) {
        number = embeddedCaseMatch.groups.number;
        title = normalizeSpace(embeddedCaseMatch.groups.title);
        pendingNumber = null;
      }
    }
    if (!number) {
      const numberMatch = CASE_NUMBER_ONLY_RE.exec(line.text);
      if (numberMatch) {
        pendingNumber = numberMatch.groups.number;
        continue;
      }
      if (!pendingNumber) continue;
      number = pendingNumber;
      title = normalizeSpace(line.text);
      pendingNumber = null;
    }
    if (!title || STOP_HEADINGS.has(title.toLowerCase()) || /^(Avd\.|Stab|KOM)/.test(title)) continue;
    agenda.push({ case_number: number, title });
  }
  return agenda;
}

function isNoiseLine(text) {
  const lower = text.trim().toLowerCase();
  return (
    /^\d+$/.test(text) ||
    ["ledemøte (lm)", "ledermøte (lm)"].includes(lower) ||
    ["saker til beslutning", "saker til diskusjon", "saker til orientering/diskusjon"].includes(lower) ||
    ["saker til beslutning/orientering/diskusjon", "saker til beslutning/diskusjon"].includes(lower) ||
    lower === "saker til informasjon / diskusjonssaker" ||
    /^\d+\s+saker til /.test(lower) ||
    lower.startsWith("nasjonal kommunikasjonsmyndighet") ||
    ["postadresse:", "besøksadresse:", "tel: 22 82 46 00"].includes(lower) ||
    lower.startsWith("www.nkom.no") ||
    lower.startsWith("postboks ") ||
    lower.startsWith("nygård ") ||
    lower.startsWith("firmapost@") ||
    lower.startsWith("no ")
  );
}

function sectionForText(text) {
  const lower = text.trim().toLowerCase();
  if (lower.startsWith("vedtak")) return "decision";
  if (SECTION_HEADINGS.has(lower)) return "followup";
  return null;
}

function cleanOwner(owner) {
  return normalizeSpace(owner).replace(/[. ]+$/g, "");
}

function splitActionText(text) {
  const match = RESPONSIBLE_RE.exec(text);
  if (!match) return { text: normalizeSpace(text), responsible: null };
  return {
    text: normalizeSpace(text.slice(0, match.index).replace(/[. ]+$/g, "")),
    responsible: cleanOwner(match.groups.owner),
  };
}

function lineCanContinueAction(text) {
  const lower = text.trim().toLowerCase();
  if (!text || text === "•" || /^\d+$/.test(text)) return false;
  if (CASE_RE.test(text) || INTRO_RE.test(text)) return false;
  if (STOP_HEADINGS.has(lower) || lower === "eventuelt" || EVENTUELT_RE.test(text) || SIRK_RE.test(text)) {
    return false;
  }
  if (lower.startsWith("saker til ") || sectionForText(text)) return false;
  if (RESPONSIBLE_RE.test(text)) return true;
  return /^[a-zæøå]/.test(text) || lower.startsWith("mtp.") || lower.startsWith("med ") || lower.startsWith("og ");
}

function syntheticCaseFromAgenda(agenda, existingNumbers) {
  return agenda.find((item) => item.case_number.startsWith("2.") && !existingNumbers.has(item.case_number)) || null;
}

function createCase(caseNumber, title, section, page) {
  return {
    case_number: caseNumber,
    title,
    section,
    source_page_start: page,
    source_page_end: page,
    body_lines: [],
    decision_lines: [],
    followup_lines: [],
    action_points: [],
  };
}

function finalizeAction(currentCase, currentAction) {
  if (!currentCase || !currentAction) return;
  const fullText = normalizeSpace(currentAction.parts.join(" "));
  const action = splitActionText(fullText);
  currentCase.action_points.push({
    action_id: currentAction.id,
    text: action.text,
    responsible: action.responsible,
    source_page: currentAction.page,
  });
}

function caseToIndexItem(currentCase, documentId, meetingDate) {
  const body = normalizeSpace(currentCase.body_lines.join(" "));
  const decision = normalizeSpace(currentCase.decision_lines.join(" "));
  const followup = normalizeSpace(currentCase.followup_lines.join(" "));
  const combined = normalizeSpace(
    [
      currentCase.case_number,
      currentCase.title,
      body,
      decision,
      followup,
      currentCase.action_points.map((ap) => `${ap.action_id} ${ap.text} ${ap.responsible || ""}`).join(" "),
    ].join(" "),
  );
  return {
    id: `${documentId}:${currentCase.case_number}:${currentCase.source_page_start}`,
    document_id: documentId,
    case_number: currentCase.case_number,
    title: currentCase.title,
    section: currentCase.section,
    meeting_date: meetingDate,
    source_page_start: currentCase.source_page_start,
    source_page_end: currentCase.source_page_end,
    body_text: body,
    decision_text: decision,
    followup_text: followup,
    action_points: currentCase.action_points.map((ap, index) => ({
      id: `${documentId}:${currentCase.case_number}:${ap.action_id}:${index + 1}`,
      action_id: ap.action_id,
      text: ap.text,
      responsible: ap.responsible,
      source_page: ap.source_page,
    })),
    search_text: combined,
    search_norm: normalize(combined),
  };
}

function parseCases(lines, start, agenda, documentId, meetingDate) {
  const cases = [];
  const agendaByNumber = new Map(agenda.map((item) => [item.case_number, item.title]));
  const existingNumbers = new Set();
  let currentCase = null;
  let currentSection = "body";
  let currentAction = null;
  let lastSectionHeading = null;
  let seenCaseSection = false;

  const closeCase = (page) => {
    if (!currentCase) return;
    finalizeAction(currentCase, currentAction);
    currentAction = null;
    currentCase.source_page_end = page || currentCase.source_page_end;
    cases.push(caseToIndexItem(currentCase, documentId, meetingDate));
    currentCase = null;
    currentSection = "body";
  };

  const ensureFirstCase = (line) => {
    if (!seenCaseSection || currentCase || cases.length) return;
    if (/^[1-4]/.test(line.text) || STOP_HEADINGS.has(line.text.toLowerCase())) return;
    if (line.text.toLowerCase() === "eventuelt" || EVENTUELT_RE.test(line.text)) return;
    const agendaCase = syntheticCaseFromAgenda(agenda, existingNumbers);
    if (!agendaCase) return;
    currentCase = createCase(agendaCase.case_number, agendaCase.title, lastSectionHeading, line.page);
    existingNumbers.add(currentCase.case_number);
    currentSection = "body";
  };

  for (const line of lines.slice(start)) {
    const text = line.text.trim();
    const lower = text.toLowerCase();
    if (lower.startsWith("saker til ") || /^\d+\s+saker til /.test(lower)) {
      seenCaseSection = true;
      lastSectionHeading = text;
    }
    if (!text || isNoiseLine(text)) continue;

    const section = sectionForText(text);
    if (section) {
      if (currentCase) {
        finalizeAction(currentCase, currentAction);
        currentAction = null;
      }
      currentSection = section;
      continue;
    }

    if (INTRO_RE.test(text)) {
      closeCase(line.page);
      continue;
    }

    const caseMatch = CASE_RE.exec(text);
    if (caseMatch) {
      closeCase(line.page);
      const number = caseMatch.groups.number;
      const extractedTitle = normalizeSpace(caseMatch.groups.title);
      const agendaTitle = agendaByNumber.get(number);
      currentCase = createCase(
        number,
        agendaTitle && agendaTitle.length > extractedTitle.length ? agendaTitle : extractedTitle,
        lastSectionHeading,
        line.page,
      );
      existingNumbers.add(number);
      currentSection = "body";
      continue;
    }

    if (lower === "eventuelt" || EVENTUELT_RE.test(text)) {
      closeCase(line.page);
      currentCase = createCase("3", "Eventuelt", "Eventuelt", line.page);
      currentSection = "body";
      continue;
    }

    if (STOP_HEADINGS.has(lower) || SIRK_RE.test(text) || lower.startsWith("saker til ")) {
      lastSectionHeading = text;
      if (lower === "sirkulasjonssaker" || SIRK_RE.test(text)) closeCase(line.page);
      continue;
    }

    ensureFirstCase(line);
    if (!currentCase) continue;

    currentCase.source_page_end = line.page;
    const apMatch = AP_RE.exec(text);
    if (apMatch) {
      finalizeAction(currentCase, currentAction);
      currentAction = {
        id: apMatch.groups.id.toUpperCase(),
        parts: [apMatch.groups.text],
        page: line.page,
      };
      currentCase.followup_lines.push(text);
      continue;
    }

    const previousActionText = currentAction ? currentAction.parts.join(" ") : "";
    if (
      currentAction &&
      (lineCanContinueAction(text) || previousActionText.trim().toLowerCase().endsWith("ansvar:"))
    ) {
      currentAction.parts.push(text);
    }

    if (currentSection === "decision") currentCase.decision_lines.push(text);
    else if (currentSection === "followup") currentCase.followup_lines.push(text);
    else currentCase.body_lines.push(text);
  }

  closeCase(lines.at(-1)?.page);
  return cases;
}

async function parsePdfFile(file) {
  const lines = await extractPdfLines(file);
  const start = protocolStart(lines);
  const metadata = extractMetadata(lines, start);
  const agenda = extractAgendaCases(lines, start);
  const documentId = slug(file.name.replace(/\.pdf$/i, ""));
  const document = {
    id: documentId,
    file_name: file.name,
    relative_path: file.name,
    protocol_start_page: lines[start]?.page || null,
    agenda_cases: agenda,
    file_size: file.size,
    file_last_modified: file.lastModified,
    ...metadata,
  };
  const cases = parseCases(lines, start, agenda, documentId, metadata.meeting_date);
  return { document, cases };
}

async function buildIndexFromFiles(files, folderName) {
  const documents = [];
  const cases = [];
  const warnings = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    setStatus(`Indekserer ${i + 1}/${files.length}`, true);
    els.datasetMeta.textContent = file.name;
    try {
      const parsed = await parsePdfFile(file);
      documents.push(parsed.document);
      cases.push(...parsed.cases);
      if (!parsed.cases.length) warnings.push(`${file.name}: fant ingen saker`);
    } catch (error) {
      warnings.push(`${file.name}: ${error.message}`);
    }
  }
  documents.sort((a, b) => collator.compare(a.meeting_date || "", b.meeting_date || ""));
  cases.sort((a, b) => {
    const dateCompare = collator.compare(a.meeting_date || "", b.meeting_date || "");
    if (dateCompare !== 0) return dateCompare;
    return collator.compare(a.case_number, b.case_number);
  });
  const actionPoints = cases.flatMap((caseItem) =>
    caseItem.action_points.map((ap) => ({
      ...ap,
      case_id: caseItem.id,
      case_number: caseItem.case_number,
      case_title: caseItem.title,
      document_id: caseItem.document_id,
      meeting_date: caseItem.meeting_date,
    })),
  );
  return {
    version: INDEX_VERSION,
    generated_at: new Date().toISOString(),
    source_dir: folderName,
    documents,
    cases,
    action_points: actionPoints,
    warnings,
    counts: {
      documents: documents.length,
      cases: cases.length,
      action_points: actionPoints.length,
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function defaultTaskData(folderName) {
  const timestamp = nowIso();
  return {
    version: TASK_DATA_VERSION,
    generated_at: timestamp,
    updated_at: timestamp,
    source_dir: folderName,
    tasks: [],
  };
}

async function readTaskDataFromFolder(handle, folderName) {
  try {
    const taskDir = await handle.getDirectoryHandle(TASK_DATA_DIR);
    const fileHandle = await taskDir.getFileHandle(TASK_DATA_FILE);
    const file = await fileHandle.getFile();
    const content = await file.text();
    if (!content.trim()) return { data: defaultTaskData(folderName), exists: true };
    const data = JSON.parse(content);
    if (!data || !Array.isArray(data.tasks)) {
      throw new Error(`${TASK_DATA_FILE} har ikke gyldig oppgavestruktur.`);
    }
    return {
      data: {
        ...data,
        version: data.version || TASK_DATA_VERSION,
        source_dir: data.source_dir || folderName,
        tasks: data.tasks,
      },
      exists: true,
    };
  } catch (error) {
    if (error.name === "NotFoundError") {
      return { data: defaultTaskData(folderName), exists: false };
    }
    throw error;
  }
}

async function writeTaskDataToFolder(handle, taskData) {
  const taskDir = await handle.getDirectoryHandle(TASK_DATA_DIR, { create: true });
  const fileHandle = await taskDir.getFileHandle(TASK_DATA_FILE, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(`${JSON.stringify(taskData, null, 2)}\n`);
  await writable.close();
}

function taskContextForCase(caseItem) {
  const parts = [
    caseItem.decision_text ? `Vedtak: ${caseItem.decision_text}` : "",
    caseItem.followup_text ? `Oppfølging: ${caseItem.followup_text}` : "",
    caseItem.body_text,
  ].filter(Boolean);
  return normalizeSpace(parts.join(" ")).slice(0, 900);
}

function taskFromActionPoint(ap, caseById, documentById, timestamp) {
  const caseItem = caseById.get(ap.case_id);
  const doc = documentById.get(ap.document_id);
  return {
    id: ap.id,
    action_id: ap.action_id,
    status: "open",
    owner: ap.responsible || "",
    due_date: "",
    extra_info: "",
    text: ap.text,
    created_at: timestamp,
    updated_at: timestamp,
    source: {
      document_id: ap.document_id,
      file_name: doc?.file_name || "",
      lm_number: doc?.lm_number || "",
      meeting_date: ap.meeting_date || caseItem?.meeting_date || "",
      case_id: ap.case_id,
      case_number: ap.case_number || caseItem?.case_number || "",
      case_title: ap.case_title || caseItem?.title || "",
      source_page: ap.source_page || null,
    },
    context: taskContextForCase(caseItem || {}),
  };
}

function mergeTaskData(index, taskData, existed) {
  const timestamp = nowIso();
  const caseById = new Map(index.cases.map((caseItem) => [caseItem.id, caseItem]));
  const documentById = new Map(index.documents.map((doc) => [doc.id, doc]));
  const tasks = [...taskData.tasks];
  const seenIds = new Set(tasks.map((task) => task.id));
  const newTasks = [];

  for (const ap of index.action_points) {
    if (seenIds.has(ap.id)) continue;
    const task = taskFromActionPoint(ap, caseById, documentById, timestamp);
    tasks.push(task);
    newTasks.push(task);
    seenIds.add(ap.id);
  }

  if (!newTasks.length && existed) {
    return { taskData: { ...taskData, tasks }, changed: false, added: 0 };
  }

  return {
    taskData: {
      ...taskData,
      version: taskData.version || TASK_DATA_VERSION,
      generated_at: taskData.generated_at || timestamp,
      updated_at: timestamp,
      tasks,
    },
    changed: true,
    added: newTasks.length,
  };
}

async function syncTaskDataForIndex(index, handle) {
  if (!(await ensureDirectoryPermission(handle, { mode: "readwrite" }))) {
    throw new Error(`Mangler skrivetilgang til å opprette ${TASK_DATA_DIR}. Velg referatmappen på nytt.`);
  }
  setStatus("Synkroniserer oppgaver", true);
  const { data, exists } = await readTaskDataFromFolder(handle, index.source_dir);
  const merged = mergeTaskData(index, data, exists);
  if (merged.changed) {
    await writeTaskDataToFolder(handle, merged.taskData);
  }
  return merged.taskData;
}

function normalizedTask(task) {
  return {
    id: task.id,
    action_id: task.action_id || "",
    status: task.status === "done" ? "done" : "open",
    owner: task.owner || "",
    due_date: task.due_date || "",
    extra_info: task.extra_info || "",
    text: task.text || "",
    created_at: task.created_at || "",
    updated_at: task.updated_at || "",
    source: task.source || {},
    context: task.context || "",
    search_norm: normalize(
      [
        task.action_id,
        task.text,
        task.owner,
        task.due_date,
        task.extra_info,
        task.source?.lm_number,
        task.source?.meeting_date,
        task.source?.case_number,
        task.source?.case_title,
        task.source?.file_name,
        task.context,
      ].join(" "),
    ),
  };
}

function prepareIndex(rawIndex) {
  rawIndex.documentsById = new Map(rawIndex.documents.map((doc) => [doc.id, doc]));
  rawIndex.cases = rawIndex.cases.map((caseItem) => ({
    ...caseItem,
    searchable: normalize(caseItem.search_text),
  }));
  rawIndex.task_data = rawIndex.task_data || defaultTaskData(rawIndex.source_dir);
  rawIndex.task_data.tasks = (rawIndex.task_data.tasks || []).map(normalizedTask);
  return rawIndex;
}

function activateIndex(index) {
  state.index = prepareIndex(index);
  const counts = state.index.counts;
  const dates = state.index.documents.map((doc) => doc.meeting_date).filter(Boolean).sort();
  const earliest = dates.at(0) || "";
  const latest = dates.at(-1) || "";
  els.dateFrom.min = earliest;
  els.dateFrom.max = latest;
  els.dateTo.min = earliest;
  els.dateTo.max = latest;
  const taskCount = state.index.task_data.tasks.length;
  els.datasetMeta.textContent = `${counts.documents} referater, ${counts.cases} saker, ${counts.action_points} aksjonspunkter, ${taskCount} oppgaver`;
  const generated = index.generated_at ? `Indeks ferdig ${new Date(index.generated_at).toLocaleString("no-NO")}` : "Indeks klar";
  setStatus(generated);
  renderOwnerFilter();
  render();
}

async function indexDirectory(handle) {
  if (!(await ensureDirectoryPermission(handle, { mode: "readwrite" }))) {
    throw new Error("Mangler lese- og skrivetilgang til valgt mappe.");
  }
  setStatus("Starter indeksering", true);
  setFolderMeta(`Valgt mappe: ${handle.name}`);
  const files = await listPdfFiles(handle);
  if (!files.length) throw new Error("Fant ingen PDF-filer i valgt mappe.");
  const index = await buildIndexFromFiles(files, handle.name);
  index.task_data = await syncTaskDataForIndex(index, handle);
  writeLocalStorageJson(STORAGE_INDEX_KEY, index);
  writeLocalStorageJson(STORAGE_FOLDER_KEY, {
    name: handle.name,
    selectedAt: new Date().toISOString(),
    indexedAt: index.generated_at,
  });
  activateIndex(index);
  if (index.warnings.length) {
    els.datasetMeta.textContent += ` (${index.warnings.length} advarsler)`;
  }
}

function fileSignaturesFromIndex(index) {
  return new Map(
    (index?.documents || []).map((doc) => [
      doc.file_name,
      {
        size: doc.file_size,
        lastModified: doc.file_last_modified,
      },
    ]),
  );
}

function fileSignaturesFromFiles(files) {
  return new Map(
    files.map((file) => [
      file.name,
      {
        size: file.size,
        lastModified: file.lastModified,
      },
    ]),
  );
}

function signaturesDiffer(indexSignatures, currentSignatures) {
  if (indexSignatures.size !== currentSignatures.size) return true;
  for (const [name, current] of currentSignatures) {
    const indexed = indexSignatures.get(name);
    if (!indexed) return true;
    if (indexed.size !== current.size || indexed.lastModified !== current.lastModified) return true;
  }
  return false;
}

async function refreshIndexIfFolderChanged() {
  if (!state.directoryHandle || !state.index) return;
  if (!(await ensureDirectoryPermission(state.directoryHandle, { request: false }))) {
    els.datasetMeta.textContent += " Må ha ny mappetilgang for å sjekke endringer.";
    setStatus("Cache lastet");
    return;
  }
  setStatus("Sjekker mappe", true);
  const files = await listPdfFiles(state.directoryHandle);
  if (!files.length) {
    setStatus("Cache lastet");
    els.datasetMeta.textContent += " Fant ingen PDF-er ved kontroll av mappen.";
    return;
  }
  const cached = state.index;
  const indexSignatures = fileSignaturesFromIndex(cached);
  const currentSignatures = fileSignaturesFromFiles(files);
  if (signaturesDiffer(indexSignatures, currentSignatures)) {
    await indexDirectory(state.directoryHandle);
    return;
  }
  setStatus("Indeks oppdatert");
}

function loadCachedIndex() {
  const cached = readLocalStorageJson(STORAGE_INDEX_KEY);
  if (!cached || cached.version !== INDEX_VERSION || !Array.isArray(cached.cases)) return false;
  activateIndex(cached);
  return true;
}

async function restoreStoredFolderHandle() {
  try {
    state.directoryHandle = await getStoredDirectoryHandle();
    const folder = readLocalStorageJson(STORAGE_FOLDER_KEY);
    if (state.directoryHandle) {
      setFolderMeta(`Husket mappe: ${state.directoryHandle.name}`);
      els.reindexFolder.disabled = false;
    } else if (folder?.name) {
      setFolderMeta(`Sist valgt mappe: ${folder.name}`);
    }
  } catch {
    els.reindexFolder.disabled = true;
  }
}

function documentFor(caseItem) {
  return state.index.documentsById.get(caseItem.document_id);
}

function taskById(taskId) {
  return state.index?.task_data.tasks.find((task) => task.id === taskId) || null;
}

function taskStatusLabel(task) {
  return task.status === "done" ? "Utført" : "Åpen";
}

function ownerFilterKey(owner) {
  return normalize(owner || "Uten ansvarlig");
}

function ownerDisplayName(owner) {
  return normalizeSpace(owner) || "Uten ansvarlig";
}

function ownerFilterOptions(tasks) {
  const byKey = new Map();
  for (const task of tasks) {
    const displayName = ownerDisplayName(task.owner);
    const key = ownerFilterKey(displayName);
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        label: displayName,
        count: 0,
      });
    }
    byKey.get(key).count += 1;
  }
  return [...byKey.values()].sort((a, b) => collator.compare(a.label, b.label));
}

function renderOwnerFilter() {
  if (!els.taskOwnerFilter || !state.index) return;
  const statusFilteredTasks = state.index.task_data.tasks.filter(passesTaskStatusFilter);
  const owners = ownerFilterOptions(statusFilteredTasks);
  const validKeys = new Set(owners.map((owner) => owner.key));
  state.taskOwners = new Set([...state.taskOwners].filter((key) => validKeys.has(key)));
  const allSelected = state.taskOwners.size === 0;
  els.taskOwnerFilter.innerHTML = [
    `<label class="owner-option owner-option-all">
      <input type="checkbox" data-owner-all ${allSelected ? "checked" : ""} />
      <span>
        <strong>Alle ansvarlige</strong>
        <small>Viser oppgaver uansett ansvarlig</small>
      </span>
    </label>`,
    ...owners.map(
      (owner) => `
        <label class="owner-option">
          <input
            type="checkbox"
            value="${escapeHtml(owner.key)}"
            data-owner-key="${escapeHtml(owner.key)}"
            ${state.taskOwners.has(owner.key) ? "checked" : ""}
          />
          <span>${escapeHtml(owner.label)}</span>
          <small>${owner.count}</small>
        </label>
      `,
    ),
  ].join("");
}

function setView(view) {
  state.view = view;
  els.viewTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  els.caseControls.hidden = view !== "search";
  els.taskControls.hidden = view !== "tasks";
  els.searchLabel.textContent = view === "tasks" ? "Søk i oppgaver" : "Søk";
  els.search.placeholder =
    view === "tasks"
      ? "AP, ansvarlig, frist, sak eller tilleggsinfo"
      : "Saksnummer, tema, ansvarlig eller aksjonspunkt";
  renderAfterUserChange();
}

function fieldScore(field, parsedQuery, weight, phraseWeight) {
  const text = normalize(field);
  if (!text) return 0;
  let score = text.includes(parsedQuery.freePhrase) && parsedQuery.freePhrase.length > 1 ? phraseWeight : 0;
  for (const exactPhrase of parsedQuery.exactPhrases) {
    if (text.includes(exactPhrase)) score += phraseWeight * 1.4;
  }
  for (const term of parsedQuery.terms) {
    if (text === term) score += weight * 4;
    else if (hasWholeWord(text, term)) score += weight * 2.8;
    else if (text.startsWith(term)) score += weight * 1.8;
    else if (text.includes(term)) score += weight;
  }
  return score;
}

function scoreCase(caseItem, parsedQuery) {
  if (!parsedQuery.terms.length && !parsedQuery.exactPhrases.length) return 1;
  const actionsText = caseItem.action_points
    .map((ap) => `${ap.action_id} ${ap.text} ${ap.responsible || ""}`)
    .join(" ");
  let score = 0;
  score += fieldScore(caseItem.case_number, parsedQuery, 120, 520);
  score += fieldScore(caseItem.title, parsedQuery, 42, 220);
  score += fieldScore(actionsText, parsedQuery, 34, 185);
  score += fieldScore(caseItem.decision_text, parsedQuery, 18, 95);
  score += fieldScore(caseItem.followup_text, parsedQuery, 18, 90);
  score += fieldScore(caseItem.body_text, parsedQuery, 9, 54);
  score += fieldScore(
    caseItem.action_points.map((ap) => ap.responsible || "").join(" "),
    parsedQuery,
    38,
    160,
  );
  if (parsedQuery.terms.some((term) => caseItem.action_points.some((ap) => normalize(ap.action_id) === term))) {
    score += 650;
  }
  if (parsedQuery.terms.some((term) => normalize(caseItem.case_number) === term)) score += 700;
  if (caseItem.action_points.length > 0 && score > 0) score += 18;
  return Math.round(score);
}

function scoreTask(task, parsedQuery) {
  if (!parsedQuery.terms.length && !parsedQuery.exactPhrases.length) return 1;
  let score = 0;
  score += fieldScore(task.action_id, parsedQuery, 120, 520);
  score += fieldScore(task.text, parsedQuery, 42, 220);
  score += fieldScore(task.owner, parsedQuery, 38, 160);
  score += fieldScore(task.extra_info, parsedQuery, 30, 130);
  score += fieldScore(task.source?.case_title, parsedQuery, 28, 120);
  score += fieldScore(task.context, parsedQuery, 14, 70);
  score += fieldScore(task.due_date, parsedQuery, 24, 100);
  if (parsedQuery.terms.some((term) => normalize(task.action_id) === term)) score += 650;
  return Math.round(score);
}

function passesFilter(caseItem) {
  const meetingDate = caseItem.meeting_date || "";
  if (state.dateFrom && (!meetingDate || meetingDate < state.dateFrom)) return false;
  if (state.dateTo && (!meetingDate || meetingDate > state.dateTo)) return false;
  if (state.filter === "actions") return caseItem.action_points.length > 0;
  if (state.filter === "decisions") return Boolean(caseItem.decision_text);
  if (state.filter === "recent") {
    const newest = state.index.documents.at(-1)?.meeting_date;
    return caseItem.meeting_date === newest;
  }
  return true;
}

function passesTaskStatusFilter(task) {
  if (state.taskFilter === "open" && task.status === "done") return false;
  if (state.taskFilter === "done" && task.status !== "done") return false;
  return true;
}

function passesTaskFilter(task) {
  if (!passesTaskStatusFilter(task)) return false;
  if (state.taskOwners.size > 0 && !state.taskOwners.has(ownerFilterKey(task.owner))) return false;
  return true;
}

function rankedCases() {
  const query = state.query.trim();
  const parsedQuery = parseSearchQuery(query);
  const exactActionQuery = parsedQuery.terms.length === 1 && /^ap\d+-\d+$/.test(parsedQuery.terms[0]);
  const exactCaseQuery = parsedQuery.terms.length === 1 && /^[2-4]\.\d+$/.test(parsedQuery.terms[0]);
  const filtered = state.index.cases
    .filter(passesFilter)
    .filter((caseItem) => {
      if (!matchesExactPhrases(caseItem.searchable, parsedQuery)) return false;
      if (exactActionQuery) {
        return caseItem.action_points.some((ap) => normalize(ap.action_id) === parsedQuery.terms[0]);
      }
      if (exactCaseQuery) return normalize(caseItem.case_number) === parsedQuery.terms[0];
      return true;
    })
    .map((caseItem) => ({
      caseItem,
      score: parsedQuery.exactPhrases.length
        ? Math.max(scoreCase(caseItem, parsedQuery), 1)
        : scoreCase(caseItem, parsedQuery),
    }))
    .filter((item) => !query || item.score > 0);
  if (!query) {
    return filtered
      .sort((a, b) => {
        const dateCompare = collator.compare(b.caseItem.meeting_date || "", a.caseItem.meeting_date || "");
        if (dateCompare !== 0) return dateCompare;
        return collator.compare(a.caseItem.case_number, b.caseItem.case_number);
      })
      .slice(0, 18);
  }
  return filtered
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.caseItem.action_points.length !== a.caseItem.action_points.length) {
        return b.caseItem.action_points.length - a.caseItem.action_points.length;
      }
      const dateCompare = collator.compare(b.caseItem.meeting_date || "", a.caseItem.meeting_date || "");
      if (dateCompare !== 0) return dateCompare;
      return collator.compare(a.caseItem.case_number, b.caseItem.case_number);
    })
    .slice(0, 25);
}

function rankedTasks() {
  const query = state.query.trim();
  const parsedQuery = parseSearchQuery(query);
  const filtered = state.index.task_data.tasks
    .filter(passesTaskFilter)
    .filter((task) => matchesExactPhrases(task.search_norm, parsedQuery))
    .map((task) => ({
      task,
      score: parsedQuery.exactPhrases.length
        ? Math.max(scoreTask(task, parsedQuery), 1)
        : scoreTask(task, parsedQuery),
    }))
    .filter((item) => !query || item.score > 0);

  return filtered.sort((a, b) => {
    if (query && b.score !== a.score) return b.score - a.score;
    if (a.task.status !== b.task.status) return a.task.status === "open" ? -1 : 1;
    const aDue = a.task.due_date || "9999-12-31";
    const bDue = b.task.due_date || "9999-12-31";
    const dueCompare = collator.compare(aDue, bDue);
    if (dueCompare !== 0) return dueCompare;
    const ownerCompare = collator.compare(ownerFilterKey(a.task.owner), ownerFilterKey(b.task.owner));
    if (ownerCompare !== 0) return ownerCompare;
    return collator.compare(b.task.source?.meeting_date || "", a.task.source?.meeting_date || "");
  });
}

function highlight(text, query) {
  const original = String(text || "");
  const parsedQuery = parseSearchQuery(query);
  const terms = [...parsedQuery.exactPhrases, ...parsedQuery.terms.filter((term) => term.length > 1)].sort(
    (a, b) => b.length - a.length,
  );
  if (!terms.length) return escapeHtml(original);
  const pattern = new RegExp(
    `(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  return escapeHtml(original).replace(pattern, "<mark>$1</mark>");
}

function excerptStart(text, start) {
  if (start <= 0) return 0;
  const boundary = text.lastIndexOf(" ", start);
  if (boundary < 0) return 0;
  return boundary >= Math.max(0, start - 30) ? boundary + 1 : start;
}

function excerptEnd(text, end) {
  if (end >= text.length) return text.length;
  const boundary = text.indexOf(" ", end);
  return boundary >= 0 && boundary <= end + 30 ? boundary : end;
}

function excerpt(caseItem, query) {
  const text = [
    caseItem.title,
    caseItem.body_text,
    caseItem.decision_text,
    caseItem.followup_text,
    ...caseItem.action_points.map((ap) => `${ap.action_id}: ${ap.text} ${ap.responsible || ""}`),
  ]
    .filter(Boolean)
    .join(" ");
  const normText = normalize(text);
  const parsedQuery = parseSearchQuery(query);
  const term = [...parsedQuery.exactPhrases, ...parsedQuery.terms].find((token) => normText.includes(token));
  if (!term) return text.slice(0, 260);
  const start = excerptStart(text, Math.max(0, normText.indexOf(term) - 80));
  const end = excerptEnd(text, Math.min(text.length, start + 300));
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

function renderActions(caseItem) {
  if (!caseItem.action_points.length) return "";
  return `
    <ul class="actions">
      ${caseItem.action_points
        .map(
          (ap) => `
            <li class="action-item">
              <span class="action-id">${highlight(ap.action_id, state.query)}</span>
              <span class="action-text">${highlight(ap.text, state.query)}</span>
              ${
                ap.responsible
                  ? `<span class="action-owner">Ansvar: ${highlight(ap.responsible, state.query)}</span>`
                  : ""
              }
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

function renderResult({ caseItem, score }) {
  const doc = documentFor(caseItem);
  return `
    <li class="result">
      <div class="case-meta">
        <span class="pill">${escapeHtml(caseItem.case_number)}</span>
        <span>${formatDate(caseItem.meeting_date)}</span>
        <span>LM ${escapeHtml(doc?.lm_number || "")}</span>
        <span>${escapeHtml(doc?.file_name || "")}</span>
        ${state.query ? `<span class="score">score ${score}</span>` : ""}
      </div>
      <h3>
        <button class="open-pdf-link" type="button" data-document-id="${escapeHtml(caseItem.document_id)}">
          ${highlight(caseItem.title, state.query)}
        </button>
      </h3>
      <p class="excerpt">${highlight(excerpt(caseItem, state.query), state.query)}</p>
      ${
        caseItem.decision_text
          ? `<p class="decision"><strong>Vedtak:</strong> ${highlight(caseItem.decision_text, state.query)}</p>`
          : ""
      }
      ${renderActions(caseItem)}
    </li>
  `;
}

function renderTask({ task, score }) {
  const source = task.source || {};
  const owner = task.owner || "Uten ansvarlig";
  return `
    <li class="task-card ${task.status === "done" ? "done" : ""}">
      <div class="task-card-head">
        <div class="case-meta">
          <span class="pill">${highlight(task.action_id, state.query)}</span>
          <span class="task-status">${taskStatusLabel(task)}</span>
          <span>${formatDate(source.meeting_date)}</span>
          <span>${escapeHtml(source.case_number || "")}</span>
          <span>${highlight(source.case_title || "", state.query)}</span>
          ${state.query ? `<span class="score">score ${score}</span>` : ""}
        </div>
        <label class="task-done">
          <input type="checkbox" data-task-done data-task-id="${escapeHtml(task.id)}" ${
            task.status === "done" ? "checked" : ""
          } />
          Utført
        </label>
      </div>
      <h3>${highlight(task.text, state.query)}</h3>
      ${task.context ? `<p class="task-context">${highlight(task.context, state.query)}</p>` : ""}
      <div class="task-source">
        <button class="open-pdf-link" type="button" data-document-id="${escapeHtml(source.document_id || "")}">
          ${escapeHtml(source.file_name || "Åpne referat")}
        </button>
        ${source.lm_number ? `<span>LM ${escapeHtml(source.lm_number)}</span>` : ""}
        ${source.source_page ? `<span>side ${escapeHtml(source.source_page)}</span>` : ""}
      </div>
      <div class="task-fields">
        <label>
          Ansvarlig
          <input
            type="text"
            value="${escapeHtml(owner === "Uten ansvarlig" ? "" : owner)}"
            data-task-field="owner"
            data-task-id="${escapeHtml(task.id)}"
          />
        </label>
        <label>
          Frist
          <input
            type="date"
            value="${escapeHtml(task.due_date || "")}"
            data-task-field="due_date"
            data-task-id="${escapeHtml(task.id)}"
          />
        </label>
        <label class="task-notes">
          Tilleggsinfo
          <textarea
            rows="2"
            data-task-field="extra_info"
            data-task-id="${escapeHtml(task.id)}"
          >${escapeHtml(task.extra_info || "")}</textarea>
        </label>
      </div>
    </li>
  `;
}

function renderTasks() {
  if (!state.index) {
    els.resultTitle.textContent = "Oppgaver";
    els.resultCount.textContent = "";
    els.results.innerHTML = `<li class="empty">Velg en lokal referatmappe for å hente oppgaver.</li>`;
    return;
  }
  const tasks = rankedTasks();
  const allTasks = state.index.task_data.tasks;
  const openCount = allTasks.filter((task) => task.status !== "done").length;
  const doneCount = allTasks.length - openCount;
  els.resultTitle.textContent = "Oppgaver";
  els.resultCount.textContent = `${tasks.length} vist, ${openCount} åpne, ${doneCount} utførte`;
  if (!tasks.length) {
    els.results.innerHTML = `<li class="empty">Ingen oppgaver.</li>`;
    return;
  }

  let currentOwner = null;
  const ownerLabels = new Map(ownerFilterOptions(allTasks).map((owner) => [owner.key, owner.label]));
  const html = [];
  for (const item of tasks) {
    const ownerKey = ownerFilterKey(item.task.owner);
    if (ownerKey !== currentOwner) {
      currentOwner = ownerKey;
      const ownerLabel = ownerLabels.get(ownerKey) || ownerDisplayName(item.task.owner);
      html.push(`<li class="owner-heading">${escapeHtml(ownerLabel)}</li>`);
    }
    html.push(renderTask(item));
  }
  els.results.innerHTML = html.join("");
}

function render() {
  if (state.view === "tasks") {
    renderTasks();
    return;
  }
  if (!state.index) {
    els.resultTitle.textContent = "Treff";
    els.resultCount.textContent = "";
    els.results.innerHTML = `<li class="empty">Velg en lokal referatmappe for å bygge søkeindeks.</li>`;
    return;
  }
  const ranked = rankedCases();
  els.resultTitle.textContent = state.query.trim() ? "Treff" : "Siste saker";
  els.resultCount.textContent = `${ranked.length} vist`;
  els.results.innerHTML = ranked.length
    ? ranked.map(renderResult).join("")
    : `<li class="empty">Ingen treff.</li>`;
}

async function saveTaskData() {
  if (!state.index || !state.directoryHandle) {
    throw new Error("Mangler valgt referatmappe.");
  }
  if (!(await ensureDirectoryPermission(state.directoryHandle, { mode: "readwrite" }))) {
    throw new Error(`Mangler skrivetilgang til ${TASK_DATA_DIR}.`);
  }
  const taskData = {
    ...state.index.task_data,
    updated_at: nowIso(),
    tasks: state.index.task_data.tasks.map(({ search_norm, ...task }) => task),
  };
  await writeTaskDataToFolder(state.directoryHandle, taskData);
  state.index.task_data = {
    ...taskData,
    tasks: taskData.tasks.map(normalizedTask),
  };
  writeLocalStorageJson(STORAGE_INDEX_KEY, {
    ...state.index,
    task_data: taskData,
    documentsById: undefined,
  });
}

async function updateTask(taskId, changes) {
  const task = taskById(taskId);
  if (!task) return;
  const nextTask = normalizedTask({
    ...task,
    ...changes,
    updated_at: nowIso(),
  });
  const index = state.index.task_data.tasks.findIndex((item) => item.id === taskId);
  state.index.task_data.tasks[index] = nextTask;
  renderOwnerFilter();
  render();
  try {
    setStatus("Lagrer oppgaver", true);
    await saveTaskData();
    setStatus("Oppgaver lagret");
  } catch (error) {
    setStatus("Kunne ikke lagre");
    els.datasetMeta.textContent = error.message;
  }
}

async function openDocument(documentId) {
  const doc = state.index?.documentsById.get(documentId);
  if (!doc || !state.directoryHandle) return;
  try {
    if (!(await ensureDirectoryPermission(state.directoryHandle))) return;
    const fileHandle = await state.directoryHandle.getFileHandle(doc.file_name);
    const file = await fileHandle.getFile();
    const url = URL.createObjectURL(file);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    setStatus("Kan ikke åpne PDF");
    els.datasetMeta.textContent = error.message;
  }
}

async function initialize() {
  const initialQuery = new URLSearchParams(window.location.search).get("q") || "";
  if (initialQuery) {
    state.query = initialQuery;
    els.search.value = initialQuery;
  }
  const hadCache = loadCachedIndex();
  await restoreStoredFolderHandle();
  if (hadCache) {
    try {
      await refreshIndexIfFolderChanged();
    } catch (error) {
      setStatus("Cache lastet");
      els.datasetMeta.textContent += ` Kunne ikke sjekke mappen: ${error.message}`;
    }
  }
  if (!hadCache) {
    if (state.directoryHandle) {
      try {
        if (await ensureDirectoryPermission(state.directoryHandle, { request: false })) {
          await indexDirectory(state.directoryHandle);
          return;
        }
        els.datasetMeta.textContent = "Indeksen må bygges på nytt. Trykk Indekser på nytt.";
      } catch (error) {
        els.datasetMeta.textContent = `Indeksen må bygges på nytt. ${error.message}`;
      }
    }
    setStatus("Velg mappe");
    render();
  }
}

els.chooseFolder.addEventListener("click", async () => {
  try {
    await chooseDirectory();
  } catch (error) {
    if (error.name === "AbortError") return;
    setStatus("Feil");
    els.datasetMeta.textContent = error.message;
  }
});

els.reindexFolder.addEventListener("click", async () => {
  if (!state.directoryHandle) return;
  try {
    await indexDirectory(state.directoryHandle);
  } catch (error) {
    setStatus("Feil");
    els.datasetMeta.textContent = error.message;
  }
});

els.search.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderAfterUserChange();
});

els.clear.addEventListener("click", () => {
  els.search.value = "";
  state.query = "";
  els.search.focus();
  renderAfterUserChange();
});

els.dateFrom.addEventListener("input", (event) => {
  state.dateFrom = event.target.value;
  renderAfterUserChange();
});

els.dateTo.addEventListener("input", (event) => {
  state.dateTo = event.target.value;
  renderAfterUserChange();
});

els.clearDates.addEventListener("click", () => {
  els.dateFrom.value = "";
  els.dateTo.value = "";
  state.dateFrom = "";
  state.dateTo = "";
  els.dateFrom.focus();
  renderAfterUserChange();
});

els.results.addEventListener("click", (event) => {
  const button = event.target.closest("[data-document-id]");
  if (!button) return;
  openDocument(button.dataset.documentId);
});

els.results.addEventListener("change", (event) => {
  const doneToggle = event.target.closest("[data-task-done]");
  if (doneToggle) {
    updateTask(doneToggle.dataset.taskId, {
      status: doneToggle.checked ? "done" : "open",
    });
    return;
  }

  const field = event.target.closest("[data-task-field]");
  if (!field) return;
  const value = field.dataset.taskField === "extra_info" ? field.value.trim() : normalizeSpace(field.value);
  updateTask(field.dataset.taskId, {
    [field.dataset.taskField]: value,
  });
});

for (const tab of els.viewTabs) {
  tab.addEventListener("click", () => {
    setView(tab.dataset.view);
  });
}

for (const filter of els.filters) {
  filter.addEventListener("click", () => {
    state.filter = filter.dataset.filter;
    els.filters.forEach((item) => item.classList.toggle("active", item === filter));
    renderAfterUserChange();
  });
}

for (const filter of els.taskFilters) {
  filter.addEventListener("click", () => {
    state.taskFilter = filter.dataset.taskFilter;
    els.taskFilters.forEach((item) => item.classList.toggle("active", item === filter));
    renderOwnerFilter();
    renderAfterUserChange();
  });
}

els.taskOwnerFilter.addEventListener("change", (event) => {
  const allToggle = event.target.closest("[data-owner-all]");
  if (allToggle) {
    state.taskOwners.clear();
    renderOwnerFilter();
    renderAfterUserChange();
    return;
  }

  const ownerToggle = event.target.closest("[data-owner-key]");
  if (!ownerToggle) return;
  if (ownerToggle.checked) {
    state.taskOwners.add(ownerToggle.dataset.ownerKey);
  } else {
    state.taskOwners.delete(ownerToggle.dataset.ownerKey);
  }
  renderOwnerFilter();
  renderAfterUserChange();
});

window.__lmReferatSearch = {
  buildIndexFromFiles,
  parsePdfFile,
  extractPdfLines,
  mergeTaskData,
  normalize,
};

initialize();
