/**
 * StateManager.gs: 숨김 시트 기반 상태 관리 + LockService 래퍼
 * _FillContent_State: 진행 상태 + 매칭 결과
 * _FillContent_Log: 감사 추적 로그
 */

var STATE_SHEET_NAME = '_FillContent_State';
var LOG_SHEET_NAME = '_FillContent_Log';

// --- 상태 관리 ---

function getOrCreateHiddenSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.hideSheet();
  }
  return sheet;
}

function saveState(state) {
  var sheet = getOrCreateHiddenSheet(STATE_SHEET_NAME);
  var json = JSON.stringify(state);
  sheet.getRange('A1').setValue(json);
}

function loadState() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(STATE_SHEET_NAME);
  if (!sheet) return null;
  var val = sheet.getRange('A1').getValue();
  if (!val) return null;
  try {
    return JSON.parse(val);
  } catch (e) {
    return null;
  }
}

function clearState() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(STATE_SHEET_NAME);
  if (sheet) sheet.getRange('A1').setValue('');
}

// --- 매칭 결과 저장 (State 시트의 A2 이하) ---

function saveMatchResults(results) {
  var sheet = getOrCreateHiddenSheet(STATE_SHEET_NAME);
  if (results.length === 0) return;
  var headers = ['row', 'itemName', 'fileId', 'fileName', 'fileUrl', 'filePath', 'matchMode', 'score', 'timestamp'];
  sheet.getRange(2, 1, 1, headers.length).setValues([headers]);
  var data = results.map(function(r) {
    return [
      r.row || '', r.itemName || '', r.fileId || '', r.fileName || '',
      r.fileUrl || '', r.filePath || '', r.matchMode || '', r.score || '', r.timestamp || ''
    ];
  });
  if (data.length > 0) {
    sheet.getRange(3, 1, data.length, headers.length).setValues(data);
  }
}

function loadMatchResults() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(STATE_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 3) return [];
  var headers = sheet.getRange(2, 1, 1, 9).getValues()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return [];
  var data = sheet.getRange(3, 1, lastRow - 2, 9).getValues();
  return data.map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  }).filter(function(r) { return r.fileId; });
}

// --- 취소 플래그 ---

function setCancelFlag() {
  PropertiesService.getScriptProperties().setProperty('cancelRequested', 'true');
}

function clearCancelFlag() {
  PropertiesService.getScriptProperties().deleteProperty('cancelRequested');
}

function isCancelRequested() {
  return PropertiesService.getScriptProperties().getProperty('cancelRequested') === 'true';
}

// --- 로그 관리 ---

function logMatch(entry) {
  var sheet = getOrCreateHiddenSheet(LOG_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 8).setValues([[
      'timestamp', 'itemName', 'searchKeywords', 'candidateCount',
      'selectedFile', 'selectionReason', 'matchMode', 'score'
    ]]);
  }
  sheet.appendRow([
    new Date().toISOString(),
    entry.itemName || '',
    entry.searchKeywords || '',
    entry.candidateCount || 0,
    entry.selectedFile || '',
    entry.selectionReason || '',
    entry.matchMode || '',
    entry.score || ''
  ]);
}

function logError(entry) {
  var sheet = getOrCreateHiddenSheet(LOG_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 8).setValues([[
      'timestamp', 'itemName', 'searchKeywords', 'candidateCount',
      'selectedFile', 'selectionReason', 'matchMode', 'score'
    ]]);
  }
  sheet.appendRow([
    new Date().toISOString(),
    entry.itemName || '',
    entry.searchKeywords || '',
    0,
    '',
    'ERROR: ' + (entry.error || ''),
    entry.matchMode || '',
    ''
  ]);
}

// --- 트리거 관리 ---

function cleanupContinuationTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    var funcName = trigger.getHandlerFunction();
    if (funcName === 'continuationHandler') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function scheduleContinuation(delayMs) {
  cleanupContinuationTriggers();
  ScriptApp.newTrigger('continuationHandler')
    .timeBased()
    .after(delayMs || 60000)
    .create();
}

function continuationHandler() {
  cleanupContinuationTriggers();
  var lock = LockService.getScriptLock();
  var hasLock = lock.tryLock(10000);
  if (!hasLock) return;
  try {
    processItems();
  } finally {
    lock.releaseLock();
  }
}

// --- 자동 업데이트 트리거 ---

function enableAutoUpdate() {
  disableAutoUpdate();
  ScriptApp.newTrigger('autoUpdateHandler')
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .create();
  PropertiesService.getScriptProperties().setProperty('autoUpdateEnabled', 'true');
}

function disableAutoUpdate() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'autoUpdateHandler') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  PropertiesService.getScriptProperties().setProperty('autoUpdateEnabled', 'false');
}

function isAutoUpdateEnabled() {
  return PropertiesService.getScriptProperties().getProperty('autoUpdateEnabled') === 'true';
}
