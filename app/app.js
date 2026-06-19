import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const INDEX_VERSION = 2;
const STORAGE_INDEX_KEY = "lmReferatSearch.index.v2";
const STORAGE_FOLDER_KEY = "lmReferatSearch.folder.v2";
const DB_NAME = "lmReferatSearch";
const DB_STORE = "handles";
const DB_HANDLE_KEY = "referatFolder";

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
  filter: "all",
  query: "",
  busy: false,
};

const els = {
  chooseFolder: document.querySelector("#choose-folder"),
  reindexFolder: document.querySelector("#reindex-folder"),
  folderMeta: document.querySelector("#folder-meta"),
  search: document.querySelector("#search"),
  clear: document.querySelector("#clear-search"),
  filters: [...document.querySelectorAll(".filter")],
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

function setStatus(text, busy = false) {
  state.busy = busy;
  els.status.textContent = text;
  els.chooseFolder.disabled = busy;
  els.reindexFolder.disabled = busy || !state.directoryHandle;
}

function setFolderMeta(text) {
  els.folderMeta.textContent = text;
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

async function ensureDirectoryPermission(handle) {
  if (!handle) return false;
  const options = { mode: "read" };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

async function chooseDirectory() {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("Nettleseren støtter ikke mappevalg. Bruk Chrome eller Edge over HTTPS.");
  }
  const handle = await window.showDirectoryPicker({ mode: "read" });
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
      }))
      .filter((item) => item.text);
    items.sort((a, b) => {
      if (Math.abs(b.y - a.y) > 2) return b.y - a.y;
      return a.x - b.x;
    });
    let current = null;
    for (const item of items) {
      if (!current || Math.abs(current.y - item.y) > 2) {
        if (current) lines.push({ text: normalizePdfLine(current.parts.join(" ")), page: pageNumber });
        current = { y: item.y, parts: [item.text] };
      } else {
        current.parts.push(item.text);
      }
    }
    if (current) lines.push({ text: normalizePdfLine(current.parts.join(" ")), page: pageNumber });
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

function prepareIndex(rawIndex) {
  rawIndex.documentsById = new Map(rawIndex.documents.map((doc) => [doc.id, doc]));
  rawIndex.cases = rawIndex.cases.map((caseItem) => ({
    ...caseItem,
    searchable: normalize(caseItem.search_text),
  }));
  return rawIndex;
}

function activateIndex(index) {
  state.index = prepareIndex(index);
  const counts = state.index.counts;
  els.datasetMeta.textContent = `${counts.documents} referater, ${counts.cases} saker, ${counts.action_points} aksjonspunkter`;
  const generated = index.generated_at ? `Indeks ferdig ${new Date(index.generated_at).toLocaleString("no-NO")}` : "Indeks klar";
  setStatus(generated);
  render();
}

async function indexDirectory(handle) {
  if (!(await ensureDirectoryPermission(handle))) {
    throw new Error("Mangler lesetilgang til valgt mappe.");
  }
  setStatus("Starter indeksering", true);
  setFolderMeta(`Valgt mappe: ${handle.name}`);
  const files = await listPdfFiles(handle);
  if (!files.length) throw new Error("Fant ingen PDF-filer i valgt mappe.");
  const index = await buildIndexFromFiles(files, handle.name);
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
  if (!(await ensureDirectoryPermission(state.directoryHandle))) {
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

function fieldScore(field, terms, exactPhrase, weight, phraseWeight) {
  const text = normalize(field);
  if (!text) return 0;
  let score = text.includes(exactPhrase) && exactPhrase.length > 1 ? phraseWeight : 0;
  for (const term of terms) {
    if (text === term) score += weight * 3;
    else if (text.startsWith(term)) score += weight * 1.8;
    else if (text.includes(term)) score += weight;
  }
  return score;
}

function scoreCase(caseItem, query) {
  const terms = tokenize(query);
  const phrase = normalize(query);
  if (!terms.length) return 1;
  const actionsText = caseItem.action_points
    .map((ap) => `${ap.action_id} ${ap.text} ${ap.responsible || ""}`)
    .join(" ");
  let score = 0;
  score += fieldScore(caseItem.case_number, terms, phrase, 120, 520);
  score += fieldScore(caseItem.title, terms, phrase, 42, 220);
  score += fieldScore(actionsText, terms, phrase, 34, 185);
  score += fieldScore(caseItem.decision_text, terms, phrase, 18, 95);
  score += fieldScore(caseItem.followup_text, terms, phrase, 18, 90);
  score += fieldScore(caseItem.body_text, terms, phrase, 9, 54);
  score += fieldScore(
    caseItem.action_points.map((ap) => ap.responsible || "").join(" "),
    terms,
    phrase,
    38,
    160,
  );
  if (caseItem.action_points.some((ap) => normalize(ap.action_id) === phrase)) score += 650;
  if (normalize(caseItem.case_number) === phrase) score += 700;
  if (caseItem.action_points.length > 0 && score > 0) score += 18;
  return Math.round(score);
}

function passesFilter(caseItem) {
  if (state.filter === "actions") return caseItem.action_points.length > 0;
  if (state.filter === "decisions") return Boolean(caseItem.decision_text);
  if (state.filter === "recent") {
    const newest = state.index.documents.at(-1)?.meeting_date;
    return caseItem.meeting_date === newest;
  }
  return true;
}

function rankedCases() {
  const query = state.query.trim();
  const phrase = normalize(query);
  const exactActionQuery = /^ap\d+-\d+$/.test(phrase);
  const exactCaseQuery = /^[2-4]\.\d+$/.test(phrase);
  const filtered = state.index.cases
    .filter(passesFilter)
    .filter((caseItem) => {
      if (exactActionQuery) {
        return caseItem.action_points.some((ap) => normalize(ap.action_id) === phrase);
      }
      if (exactCaseQuery) return normalize(caseItem.case_number) === phrase;
      return true;
    })
    .map((caseItem) => ({ caseItem, score: scoreCase(caseItem, query) }))
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

function highlight(text, query) {
  const original = String(text || "");
  const terms = tokenize(query).filter((term) => term.length > 1);
  if (!terms.length) return escapeHtml(original);
  const pattern = new RegExp(
    `(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  return escapeHtml(original).replace(pattern, "<mark>$1</mark>");
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
  const term = tokenize(query).find((token) => normText.includes(token));
  if (!term) return text.slice(0, 260);
  const start = Math.max(0, normText.indexOf(term) - 80);
  const end = Math.min(text.length, start + 300);
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

function render() {
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
  render();
});

els.clear.addEventListener("click", () => {
  els.search.value = "";
  state.query = "";
  els.search.focus();
  render();
});

els.results.addEventListener("click", (event) => {
  const button = event.target.closest("[data-document-id]");
  if (!button) return;
  openDocument(button.dataset.documentId);
});

for (const filter of els.filters) {
  filter.addEventListener("click", () => {
    state.filter = filter.dataset.filter;
    els.filters.forEach((item) => item.classList.toggle("active", item === filter));
    render();
  });
}

window.__lmReferatSearch = {
  buildIndexFromFiles,
  parsePdfFile,
  extractPdfLines,
  normalize,
};

initialize();
