/**
 * SearchEngine.gs: 메인 처리 루프
 *
 * AI 모드 흐름 (파일 내용 기반 일괄 매칭):
 *   Phase 1: 폴더 트리 수집
 *   Phase 2: 파일 목록 수집 + 내용 인덱싱 (페이지 단위, Continue 최적화)
 *   Phase 3: 매칭 계획 수립 (시트 전체 분석)
 *   Phase 4: Gemini 일괄 매칭 (항목 ↔ 파일+페이지)
 *   Phase 5: 결과 기입
 *
 * 키워드 모드 흐름 (기존 방식 유지):
 *   Phase 1 → 항목별 개별 검색+매칭 → 결과 기입
 */

var ITEM_TIMEOUT_MS = 50000;

/**
 * config에 저장된 시트명으로 대상 시트를 반환한다.
 * continuation 트리거에서도 항상 시작 시점의 시트를 사용.
 */
function getTargetSheet(config) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (config && config.sheetName) {
    var sheet = ss.getSheetByName(config.sheetName);
    if (sheet) return sheet;
  }
  return ss.getActiveSheet();
}

function processItems() {
  var startTime = Date.now();
  var state = loadState();
  if (!state || !state.config) return;

  if (isCancelRequested()) {
    state.phase = 'DONE';
    clearCancelFlag();
    saveState(state);
    return;
  }

  var config = state.config;

  // ================================================================
  // Phase 1: 폴더 트리 수집 (모든 모드 공통)
  // ================================================================
  if (state.phase === 'TREE_COLLECTION') {
    var treeResult = collectSubfolders(
      extractFolderIdFromUrl(config.folderUrl),
      startTime,
      state.treeState || null
    );
    if (treeResult === null) return;

    state.folderIds = treeResult.folderIds;
    state.pathMap = treeResult.pathMap;

    var sheet = getTargetSheet(config);
    state.totalItems = sheet.getLastRow() > 1 ? sheet.getLastRow() - 1 : 0;
    state.lastProcessedIndex = 0;

    // AI 모드면 파일 인덱싱 단계로, 키워드 모드면 바로 처리
    if (config.matchMode === 'ai' || config.matchMode === 'keyword_then_ai') {
      state.phase = 'FILE_INDEXING';
    } else {
      state.phase = 'ITEM_PROCESSING';
    }
    saveState(state);
  }

  // ================================================================
  // Phase 2: 파일 목록 수집 + 내용 인덱싱 (AI 모드)
  // ================================================================
  if (state.phase === 'FILE_INDEXING') {
    if (!state.allFiles) {
      state.allFiles = collectAllFiles(state.folderIds);
      state.fileIndexes = [];
      state.fileIndexPos = 0;
      saveState(state);

      if (Date.now() - startTime > TIME_LIMIT_MS) {
        scheduleContinuation(60000);
        return;
      }
    }

    // 시트 항목 읽기 (인덱싱 시 quickMatch에 필요)
    var searchItems = readAllSearchItems(state);

    // 파일별 내용 인덱싱 (Continue 최적화)
    var pos = state.fileIndexPos || 0;
    while (pos < state.allFiles.length) {
      if (isCancelRequested()) {
        state.phase = 'DONE';
        clearCancelFlag();
        saveState(state);
        return;
      }
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        state.fileIndexPos = pos;
        saveState(state);
        scheduleContinuation(60000);
        return;
      }

      var file = state.allFiles[pos];
      var index = indexFileContent(file, searchItems, startTime);
      state.fileIndexes.push(index);
      pos++;

      // 10개마다 상태 저장
      if (pos % 10 === 0) {
        state.fileIndexPos = pos;
        state.processedCount = pos;
        state.totalItems = state.allFiles.length; // 진행률 표시용
        saveState(state);
      }
    }

    state.fileIndexPos = pos;
    state.phase = 'MATCHING_PLAN';
    saveState(state);
  }

  // ================================================================
  // Phase 3: 매칭 계획 수립 (AI 모드)
  // ================================================================
  if (state.phase === 'MATCHING_PLAN') {
    var apiKey = getGeminiApiKey();
    if (!apiKey) {
      // API 키 없으면 키워드 모드로 fallback
      state.phase = 'ITEM_PROCESSING';
      saveState(state);
    } else {
      var searchItems = readAllSearchItems(state);

      if (!state.matchingPlan) {
        try {
          state.matchingPlan = createMatchingPlan(searchItems, apiKey);
        } catch (e) {
          state.matchingPlan = { domain: 'unknown' };
          logError({ itemName: 'MatchingPlan', error: e.message, matchMode: 'plan' });
        }
        saveState(state);
      }

      state.phase = 'AI_BULK_MATCHING';
      // 진행률 표시 리셋
      state.totalItems = readAllSearchItems(state).length;
      state.processedCount = 0;
      saveState(state);

      if (Date.now() - startTime > TIME_LIMIT_MS) {
        scheduleContinuation(60000);
        return;
      }
    }
  }

  // ================================================================
  // Phase 4: Gemini 일괄 매칭 (AI 모드)
  // ================================================================
  if (state.phase === 'AI_BULK_MATCHING') {
    var apiKey = getGeminiApiKey();
    var searchItems = readAllSearchItems(state);
    var fileIndices = state.fileIndexes || [];

    var matches;
    try {
      matches = geminiMatchAllChunked(searchItems, fileIndices, state.matchingPlan, apiKey, startTime);
    } catch (e) {
      logError({ itemName: 'BulkMatching', error: e.message, matchMode: 'ai' });
      matches = [];
    }

    state.aiMatches = matches;
    state.phase = 'WRITE_RESULTS';
    saveState(state);

    if (Date.now() - startTime > TIME_LIMIT_MS) {
      scheduleContinuation(60000);
      return;
    }
  }

  // ================================================================
  // Phase 5: 결과 기입 (AI 모드)
  // ================================================================
  if (state.phase === 'WRITE_RESULTS') {
    var sheet = getTargetSheet(config);
    var searchColIndices = config.searchColIndices || [config.searchColIndex];
    var resultCol = config.resultColIndex + 1;
    var remarksCol = config.remarksColIndex >= 0 ? config.remarksColIndex + 1 : -1;
    var matches = state.aiMatches || [];
    var searchItems = readAllSearchItems(state);
    var matchResults = [];

    state.successCount = 0;
    state.failCount = 0;
    state.multiMatchCount = 0;
    state.errors = [];

    for (var i = 0; i < searchItems.length; i++) {
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        state.processedCount = i;
        saveState(state);
        scheduleContinuation(60000);
        return;
      }

      var row = i + 2;
      var match = matches.find(function(m) { return m.itemIndex === i; });

      if (match && match.fileId && match.score >= 60) {
        var fileUrl = getFileUrl(match.fileId);
        var displayValue = match.fileName + '\n' + fileUrl;
        sheet.getRange(row, resultCol).setValue(displayValue);

        var remarks = 'AI 점수: ' + match.score;
        if (match.page) remarks += ' | ' + match.page;
        if (match.reason) remarks += ' | ' + match.reason;
        if (remarksCol > 0) sheet.getRange(row, remarksCol).setValue(remarks);

        state.successCount++;

        matchResults.push({
          row: row,
          itemName: searchItems[i].substring(0, 50),
          fileId: match.fileId,
          fileName: match.fileName,
          fileUrl: fileUrl,
          matchMode: 'ai',
          score: match.score,
          timestamp: new Date().toISOString()
        });

        logMatch({
          itemName: searchItems[i].substring(0, 50),
          searchKeywords: '',
          candidateCount: 1,
          selectedFile: match.fileName,
          selectionReason: match.reason || '',
          matchMode: 'ai-bulk',
          score: match.score
        });
      } else {
        state.failCount++;
        var reason = (match && match.reason) ? match.reason : '관련 파일 없음';
        if (state.errors.length < 50) {
          state.errors.push(searchItems[i].substring(0, 30) + ': ' + reason);
        }
        if (remarksCol > 0) {
          sheet.getRange(row, remarksCol).setValue('매칭 실패 — ' + reason);
        }
        logError({
          itemName: searchItems[i].substring(0, 50),
          error: reason,
          matchMode: 'ai-bulk'
        });
      }

      state.processedCount = i + 1;
    }

    if (matchResults.length > 0) saveMatchResults(matchResults);
    state.phase = 'DONE';
    state.totalItems = searchItems.length;
    saveState(state);
  }

  // ================================================================
  // 키워드 모드: 항목별 개별 처리 (기존 방식)
  // ================================================================
  if (state.phase === 'ITEM_PROCESSING') {
    var sheet = getTargetSheet(config);
    var searchColIndices = config.searchColIndices || [config.searchColIndex];
    var resultCol = config.resultColIndex + 1;
    var remarksCol = config.remarksColIndex >= 0 ? config.remarksColIndex + 1 : -1;
    var matchResults = [];

    for (var i = state.lastProcessedIndex; i < state.totalItems; i++) {
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        state.lastProcessedIndex = i;
        saveState(state);
        scheduleContinuation(60000);
        return;
      }
      if (isCancelRequested()) {
        state.phase = 'DONE';
        clearCancelFlag();
        saveState(state);
        return;
      }

      var row = i + 2;
      var contentParts = [];
      searchColIndices.forEach(function(colIdx) {
        var val = sheet.getRange(row, colIdx + 1).getValue();
        if (val && String(val).trim() !== '') contentParts.push(String(val).trim());
      });
      var itemContent = contentParts.join(' ');

      if (!itemContent) {
        state.processedCount = (state.processedCount || 0) + 1;
        state.lastProcessedIndex = i + 1;
        saveState(state);
        continue;
      }

      var result = processItemKeyword(String(itemContent), state);

      if (result.success && result.fileUrl) {
        sheet.getRange(row, resultCol).setValue(result.fileName + '\n' + result.fileUrl);
        if (remarksCol > 0 && result.remarks) sheet.getRange(row, remarksCol).setValue(result.remarks);
        state.successCount = (state.successCount || 0) + 1;

        matchResults.push({
          row: row, itemName: itemContent.substring(0, 50), fileId: result.fileId,
          fileName: result.fileName, fileUrl: result.fileUrl, matchMode: 'keyword',
          score: '', timestamp: new Date().toISOString()
        });
        logMatch({
          itemName: itemContent.substring(0, 50), searchKeywords: (result.keywords || []).join(', '),
          candidateCount: result.candidateCount || 0, selectedFile: result.fileName,
          selectionReason: '', matchMode: 'keyword'
        });
      } else {
        state.failCount = (state.failCount || 0) + 1;
        state.errors = state.errors || [];
        if (state.errors.length < 50) state.errors.push(itemContent.substring(0, 30) + ': ' + (result.error || '매칭 실패'));
        if (remarksCol > 0) sheet.getRange(row, remarksCol).setValue('매칭 실패 — ' + (result.error || '관련 파일 없음'));
      }

      state.processedCount = (state.processedCount || 0) + 1;
      state.lastProcessedIndex = i + 1;
      saveState(state);
    }

    if (matchResults.length > 0) saveMatchResults(matchResults);
    state.phase = 'DONE';
    saveState(state);
  }
}

// ================================================================
// 키워드 모드용 개별 항목 처리
// ================================================================

function processItemKeyword(itemContent, state) {
  var folderIds = state.folderIds || [];
  var pathMap = state.pathMap || {};

  var searchResult = searchByKeyword(itemContent, folderIds);
  var files = searchResult.files || [];
  if (files.length === 0) {
    return { success: false, error: '관련 파일 없음', keywords: searchResult.keywords };
  }

  var resolved = resolveVersion(files);
  var bestFile = Array.isArray(resolved) ? resolved[0] : resolved;

  var remarks = '';
  var coverage = bestFile._coverage;
  if (coverage) {
    remarks = '커버리지: ' + coverage.coveragePercent + '%';
    if (coverage.pageString) remarks += ' | ' + coverage.pageString;
  }

  return {
    success: true, fileId: bestFile.id, fileName: bestFile.name,
    fileUrl: getFileUrl(bestFile.id), keywords: searchResult.keywords,
    candidateCount: files.length, remarks: remarks
  };
}

// ================================================================
// 유틸리티
// ================================================================

function readAllSearchItems(state) {
  if (state._searchItemsCache) return state._searchItemsCache;

  var sheet = getTargetSheet(state.config);
  var config = state.config;
  var searchColIndices = config.searchColIndices || [config.searchColIndex];
  var lastRow = sheet.getLastRow();
  var items = [];

  for (var r = 2; r <= lastRow; r++) {
    var parts = [];
    searchColIndices.forEach(function(colIdx) {
      var val = sheet.getRange(r, colIdx + 1).getValue();
      if (val && String(val).trim() !== '') parts.push(String(val).trim());
    });
    items.push(parts.join(' '));
  }

  state._searchItemsCache = items;
  return items;
}

function activateLogSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var logSheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (logSheet) {
    logSheet.showSheet();
    logSheet.activate();
  } else {
    SpreadsheetApp.getUi().alert('매칭 로그가 아직 없습니다. 검색을 먼저 실행하세요.');
  }
}
