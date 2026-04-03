/**
 * FillContent — 솔루션 상용화 표준 매뉴얼 산출물 자동 매칭 도구
 * Code.gs: 진입점, 메뉴 등록, 사이드바 열기, 서버-클라이언트 브릿지
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('FillContent')
    .addItem('사이드바 열기', 'showSidebar')
    .addItem('자동 갱신 설정', 'showAutoUpdateSettings')
    .addToUi();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('FillContent')
    .setWidth(300);
  SpreadsheetApp.getUi().showSidebar(html);
}

function showAutoUpdateSettings() {
  const isEnabled = isAutoUpdateEnabled();
  const ui = SpreadsheetApp.getUi();
  if (isEnabled) {
    const response = ui.alert(
      '자동 갱신',
      '자동 갱신이 활성화되어 있습니다.\n비활성화하시겠습니까?',
      ui.ButtonSet.YES_NO
    );
    if (response === ui.Button.YES) {
      disableAutoUpdate();
      ui.alert('자동 갱신이 비활성화되었습니다.');
    }
  } else {
    const response = ui.alert(
      '자동 갱신',
      '매일 자동으로 산출물 위치를 갱신합니다.\n활성화하시겠습니까?',
      ui.ButtonSet.YES_NO
    );
    if (response === ui.Button.YES) {
      enableAutoUpdate();
      ui.alert('자동 갱신이 활성화되었습니다.');
    }
  }
}

// --- 사이드바 → 서버 브릿지 함수들 ---

function getSheetHeaders() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return headers.filter(function(h) { return h !== ''; });
}

function parseFolderUrl(url) {
  const folderId = extractFolderIdFromUrl(url);
  if (!folderId) {
    return { success: false, error: '유효하지 않은 폴더 URL입니다.' };
  }
  try {
    const folder = DriveApp.getFolderById(folderId);
    return { success: true, folderId: folderId, folderName: folder.getName() };
  } catch (e) {
    return { success: false, error: '폴더에 접근할 수 없습니다: ' + e.message };
  }
}

function extractFolderIdFromUrl(url) {
  if (!url) return null;
  // https://drive.google.com/drive/folders/FOLDER_ID
  var match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // https://drive.google.com/drive/u/0/folders/FOLDER_ID
  match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // 직접 ID 입력
  if (/^[a-zA-Z0-9_-]{10,}$/.test(url.trim())) return url.trim();
  return null;
}

function startSearch(config) {
  // 이미 실행 중인지 확인 (잠금 시도 → 즉시 해제)
  var lock = LockService.getScriptLock();
  var hasLock = lock.tryLock(1000);
  if (!hasLock) {
    return { success: false, error: '이미 검색이 실행 중입니다. 잠시 후 다시 시도하세요.' };
  }
  lock.releaseLock();

  saveRecentFolder(config.folderUrl);

  // 현재 활성 시트명을 저장 — continuation 트리거에서도 같은 시트 사용
  var activeSheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  config.sheetName = activeSheet.getName();

  var state = {
    phase: 'TREE_COLLECTION',
    config: config,
    lastProcessedIndex: 0,
    totalItems: 0,
    processedCount: 0,
    successCount: 0,
    multiMatchCount: 0,
    failCount: 0,
    errors: [],
    startedAt: new Date().toISOString(),
    folderIds: [],
    pathMap: {}
  };
  saveState(state);
  clearCancelFlag();

  // processItems()를 직접 호출하지 않고 트리거로 예약.
  // 이렇게 하면 startSearch()가 즉시 반환되어
  // cancelSearch() 호출이 블로킹되지 않는다.
  scheduleContinuation(1000); // 1초 후 실행

  return { success: true };
}

function cancelSearch() {
  setCancelFlag();
  cleanupContinuationTriggers(); // 예약된 다음 실행도 취소
  var state = loadState();
  if (state && state.phase !== 'DONE') {
    state.phase = 'DONE';
    saveState(state);
  }
  return { success: true };
}

function getProgress() {
  var state = loadState();
  if (!state) {
    return { phase: 'IDLE', processedCount: 0, totalItems: 0 };
  }
  return {
    phase: state.phase || 'IDLE',
    processedCount: state.processedCount || 0,
    totalItems: state.totalItems || 0,
    successCount: state.successCount || 0,
    multiMatchCount: state.multiMatchCount || 0,
    failCount: state.failCount || 0,
    errors: (state.errors || []).slice(-5),
    startedAt: state.startedAt
  };
}

function getRecentFolders() {
  var props = PropertiesService.getUserProperties();
  var recent = props.getProperty('recentFolders');
  if (!recent) return [];
  try {
    return JSON.parse(recent);
  } catch (e) {
    return [];
  }
}

function saveRecentFolder(url) {
  var props = PropertiesService.getUserProperties();
  var recent = [];
  try {
    recent = JSON.parse(props.getProperty('recentFolders') || '[]');
  } catch (e) {
    recent = [];
  }
  var parsed = parseFolderUrl(url);
  if (!parsed.success) return;
  var entry = { url: url, name: parsed.folderName, folderId: parsed.folderId };
  recent = recent.filter(function(r) { return r.folderId !== entry.folderId; });
  recent.unshift(entry);
  if (recent.length > 3) recent = recent.slice(0, 3);
  props.setProperty('recentFolders', JSON.stringify(recent));
}

function isWelcomeSeen() {
  return PropertiesService.getUserProperties().getProperty('welcomeSeen') === 'true';
}

function setWelcomeSeen() {
  PropertiesService.getUserProperties().setProperty('welcomeSeen', 'true');
}

function getGeminiApiKey() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
}

function setGeminiApiKey(key) {
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
}
