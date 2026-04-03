/**
 * SearchEngine.gs: 메인 처리 루프
 * Strategy 패턴: processItem(item, searchStrategy)
 * 시간 기반 자동 중단 + continuation
 */

var ITEM_TIMEOUT_MS = 50000; // 단일 항목 50초 제한

function processItems() {
  var startTime = Date.now();
  var state = loadState();
  if (!state || !state.config) return;

  // Phase 1: 폴더 트리 수집
  if (state.phase === 'TREE_COLLECTION') {
    var treeResult = collectSubfolders(
      extractFolderIdFromUrl(state.config.folderUrl),
      startTime,
      state.treeState || null
    );

    if (treeResult === null) return; // continuation 예약됨

    state.folderIds = treeResult.folderIds;
    state.pathMap = treeResult.pathMap;
    state.phase = 'PROCESSING';

    // 시트에서 검색 대상 항목 수 세기
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var lastRow = sheet.getLastRow();
    state.totalItems = lastRow > 1 ? lastRow - 1 : 0;
    state.lastProcessedIndex = 0;
    saveState(state);
  }

  // Phase 2: 항목별 처리
  if (state.phase === 'PROCESSING') {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var config = state.config;
    // 복수 검색 컬럼 지원 (하위 호환: searchColIndex → searchColIndices)
    var searchColIndices = config.searchColIndices || [config.searchColIndex];
    var resultCol = config.resultColIndex + 1;
    var remarksCol = config.remarksColIndex >= 0 ? config.remarksColIndex + 1 : -1;
    var matchResults = [];

    for (var i = state.lastProcessedIndex; i < state.totalItems; i++) {
      // 시간 체크
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        state.lastProcessedIndex = i;
        state.phase = 'PROCESSING';
        saveState(state);
        scheduleContinuation(60000);
        return;
      }

      // 취소 체크
      if (isCancelRequested()) {
        state.phase = 'DONE';
        clearCancelFlag();
        saveState(state);
        return;
      }

      var row = i + 2; // 헤더 = 1행, 데이터 = 2행~

      // 복수 컬럼에서 내용을 읽어 결합 (공백 구분)
      var contentParts = [];
      searchColIndices.forEach(function(colIdx) {
        var val = sheet.getRange(row, colIdx + 1).getValue(); // 0-based → 1-based
        if (val && String(val).trim() !== '') {
          contentParts.push(String(val).trim());
        }
      });
      var itemContent = contentParts.join(' ');

      if (!itemContent || itemContent.trim() === '') {
        state.lastProcessedIndex = i + 1;
        state.processedCount = (state.processedCount || 0) + 1;
        saveState(state);
        continue;
      }

      var itemStartTime = Date.now();
      var result = processItem(String(itemContent), state, config.matchMode);

      // 단일 항목 타임아웃 체크
      if (Date.now() - itemStartTime > ITEM_TIMEOUT_MS) {
        result = { success: false, error: '타임아웃 — 항목 처리 시간 초과' };
      }

      // 결과 기입
      if (result.success && result.fileUrl) {
        sheet.getRange(row, resultCol).setValue(result.fileUrl);
        if (remarksCol > 0 && result.remarks) {
          sheet.getRange(row, remarksCol).setValue(result.remarks);
        }
        state.successCount = (state.successCount || 0) + 1;

        if (result.isMultiMatch) {
          state.multiMatchCount = (state.multiMatchCount || 0) + 1;
        }

        matchResults.push({
          row: row,
          itemName: String(itemContent).substring(0, 50),
          fileId: result.fileId,
          fileName: result.fileName,
          fileUrl: result.fileUrl,
          filePath: result.filePath,
          matchMode: config.matchMode,
          score: result.score || '',
          timestamp: new Date().toISOString()
        });

        logMatch({
          itemName: String(itemContent).substring(0, 50),
          searchKeywords: (result.keywords || []).join(', '),
          candidateCount: result.candidateCount || 0,
          selectedFile: result.fileName,
          selectionReason: result.selectionReason || '',
          matchMode: config.matchMode,
          score: result.score || ''
        });
      } else {
        state.failCount = (state.failCount || 0) + 1;
        var errorMsg = String(itemContent).substring(0, 30) + ': ' + (result.error || '매칭 실패');
        state.errors = state.errors || [];
        if (state.errors.length < 50) state.errors.push(errorMsg);

        if (remarksCol > 0) {
          sheet.getRange(row, remarksCol).setValue('매칭 실패 — ' + (result.error || '관련 파일 없음'));
        }

        logError({
          itemName: String(itemContent).substring(0, 50),
          searchKeywords: (result.keywords || []).join(', '),
          error: result.error || '매칭 실패',
          matchMode: config.matchMode
        });
      }

      state.processedCount = (state.processedCount || 0) + 1;
      state.lastProcessedIndex = i + 1;
      saveState(state);
    }

    // 매칭 결과 저장
    if (matchResults.length > 0) {
      saveMatchResults(matchResults);
    }

    state.phase = 'DONE';
    saveState(state);
  }
}

function processItem(itemContent, state, matchMode) {
  var folderIds = state.folderIds || [];
  var pathMap = state.pathMap || {};
  var searchResult;

  if (matchMode === 'ai') {
    searchResult = searchByAI(itemContent, folderIds);
    // AI 실패 시 키워드 fallback
    if (searchResult.error === 'AI_FALLBACK') {
      searchResult = searchByKeyword(itemContent, folderIds);
      searchResult.fallback = true;
    }
  } else if (matchMode === 'keyword_then_ai') {
    // 1차: 키워드로 후보 수집 (커버리지 검증 없이 Drive 검색만)
    var keywordCandidates = searchByKeywordRaw(itemContent, folderIds);

    if (keywordCandidates.files && keywordCandidates.files.length > 0) {
      // 2차: 키워드 후보를 AI가 관련도 검증
      searchResult = verifyWithAI(itemContent, keywordCandidates);
      if (searchResult.files && searchResult.files.length > 0) {
        searchResult.verifiedByAI = true;
      } else {
        // AI 검증 통과 후보 없음 → AI로 전체 재검색
        var aiResult = searchByAI(itemContent, folderIds);
        if (aiResult.error !== 'AI_FALLBACK' && aiResult.files && aiResult.files.length > 0) {
          searchResult = aiResult;
          searchResult.escalatedToAI = true;
        } else {
          searchResult = keywordCandidates;
          searchResult.aiVerifyFailed = true;
        }
      }
    } else {
      // 키워드 후보 0건 → AI로 전체 검색
      var aiResult = searchByAI(itemContent, folderIds);
      if (aiResult.error !== 'AI_FALLBACK' && aiResult.files && aiResult.files.length > 0) {
        searchResult = aiResult;
        searchResult.escalatedToAI = true;
      } else {
        searchResult = keywordCandidates;
      }
    }
  } else {
    searchResult = searchByKeyword(itemContent, folderIds);
  }

  var files = searchResult.files || [];
  if (files.length === 0) {
    return {
      success: false,
      error: searchResult.error || '관련 파일을 찾을 수 없습니다',
      keywords: searchResult.keywords
    };
  }

  // 버전 해석
  var resolved = resolveVersion(files);
  var bestFile;
  var isMultiMatch = false;
  var remarks = '';

  if (Array.isArray(resolved)) {
    // 여러 기본명 그룹이 있는 경우 — 첫 번째 선택, 나머지 비고
    bestFile = resolved[0];
    isMultiMatch = true;
    var otherNames = resolved.slice(1).map(function(f) { return f.name; }).join(', ');
    remarks = '후보 ' + resolved.length + '개 (' + otherNames + ')';
  } else {
    bestFile = resolved;
  }

  // AI 스코어 반영
  if (searchResult.scores) {
    var fileScore = searchResult.scores.find(function(s) { return s.file.id === bestFile.id; });
    if (fileScore) {
      remarks = (remarks ? remarks + ' | ' : '') + 'AI 점수: ' + fileScore.score;
    }
    // AI 다중 후보 (70점 이상 여러 개)
    var highScores = searchResult.scores.filter(function(s) { return s.score >= RELEVANCE_THRESHOLD; });
    if (highScores.length > 1) {
      isMultiMatch = true;
      var otherFiles = highScores.filter(function(s) { return s.file.id !== bestFile.id; });
      if (otherFiles.length > 0) {
        remarks = '후보 ' + highScores.length + '개 (' +
          otherFiles.map(function(s) { return s.file.name + ':' + s.score + '점'; }).join(', ') + ')';
      }
    }
  }

  if (searchResult.fallback) {
    remarks = (remarks ? remarks + ' | ' : '') + 'AI 매칭 실패, 키워드 매칭으로 대체';
  }

  if (searchResult.verifiedByAI) {
    remarks = (remarks ? remarks + ' | ' : '') + '키워드 후보 → AI 검증 통과';
  }

  if (searchResult.escalatedToAI) {
    remarks = (remarks ? remarks + ' | ' : '') + '키워드 실패 → AI 전체 재검색으로 매칭';
  }

  if (searchResult.aiVerifyFailed) {
    remarks = (remarks ? remarks + ' | ' : '') + 'AI 검증 미통과 — 키워드 매칭 결과 사용';
  }

  // 커버리지 + 페이지 정보를 비고에 추가
  var coverage = bestFile._coverage;
  if (coverage) {
    remarks = (remarks ? remarks + ' | ' : '') + '커버리지: ' + coverage.coveragePercent + '%';
    if (coverage.pageString) {
      remarks += ' | ' + coverage.pageString;
    }
    if (coverage.unmatchedTerms && coverage.unmatchedTerms.length > 0) {
      remarks += ' | 미포함: ' + coverage.unmatchedTerms.slice(0, 3).join(', ');
    }
  }

  var filePath = getFilePath(bestFile.id, pathMap);
  var fileUrl = getFileUrl(bestFile.id);

  return {
    success: true,
    fileId: bestFile.id,
    fileName: bestFile.name,
    fileUrl: fileUrl,
    filePath: filePath,
    keywords: searchResult.keywords,
    candidateCount: files.length,
    selectionReason: bestFile.selectionReason || '최고 버전/최신 파일',
    score: searchResult.scores ? (searchResult.scores[0] || {}).score : '',
    isMultiMatch: isMultiMatch,
    remarks: remarks
  };
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
