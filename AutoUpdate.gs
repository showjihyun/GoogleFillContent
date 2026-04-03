/**
 * AutoUpdate.gs: 자동 업데이트 트리거
 * 매일 실행 — 기존 매칭 결과의 파일 상태 확인 + 경로 갱신
 */

function autoUpdateHandler() {
  var lock = LockService.getScriptLock();
  var hasLock = lock.tryLock(10000);
  if (!hasLock) {
    Logger.log('autoUpdate: 다른 작업이 실행 중이므로 건너뜁니다');
    return;
  }

  try {
    runAutoUpdate();
  } finally {
    lock.releaseLock();
  }
}

function runAutoUpdate() {
  var startTime = Date.now();
  var results = loadMatchResults();
  if (!results || results.length === 0) {
    Logger.log('autoUpdate: 매칭 결과가 없습니다');
    return;
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var updatedCount = 0;
  var errorCount = 0;

  for (var i = 0; i < results.length; i++) {
    if (Date.now() - startTime > TIME_LIMIT_MS) {
      Logger.log('autoUpdate: 시간 제한 도달 — ' + i + '/' + results.length + ' 처리됨');
      break;
    }

    var entry = results[i];
    if (!entry.fileId || !entry.row) continue;

    var row = parseInt(entry.row);
    if (isNaN(row) || row < 2) continue;

    try {
      var fileStatus = checkFileStatus(entry.fileId);

      if (fileStatus.deleted) {
        sheet.getRange(row, getResultColFromState()).setValue('');
        var remarksCol = getRemarksColFromState();
        if (remarksCol > 0) {
          sheet.getRange(row, remarksCol).setValue('파일 삭제됨 — 재검색 필요');
        }
        entry.fileId = '';
        updatedCount++;
        logMatch({
          itemName: entry.itemName,
          searchKeywords: '',
          candidateCount: 0,
          selectedFile: '',
          selectionReason: 'AUTO_UPDATE: 파일 삭제 감지',
          matchMode: 'auto-update'
        });
        continue;
      }

      // 파일명 변경 또는 이동 감지
      if (fileStatus.nameChanged || fileStatus.parentChanged) {
        var newUrl = getFileUrl(entry.fileId);
        sheet.getRange(row, getResultColFromState()).setValue(newUrl);
        entry.fileUrl = newUrl;
        entry.fileName = fileStatus.currentName;
        updatedCount++;
        logMatch({
          itemName: entry.itemName,
          searchKeywords: '',
          candidateCount: 1,
          selectedFile: fileStatus.currentName,
          selectionReason: 'AUTO_UPDATE: 파일 이동/이름 변경 감지',
          matchMode: 'auto-update'
        });
      }

      // 같은 폴더에 새 버전이 있는지 확인
      var newerVersion = checkForNewerVersion(entry);
      if (newerVersion) {
        var newUrl = getFileUrl(newerVersion.id);
        sheet.getRange(row, getResultColFromState()).setValue(newUrl);
        var remarksCol = getRemarksColFromState();
        if (remarksCol > 0) {
          sheet.getRange(row, remarksCol).setValue('새 버전 감지: ' + newerVersion.name);
        }
        entry.fileId = newerVersion.id;
        entry.fileName = newerVersion.name;
        entry.fileUrl = newUrl;
        updatedCount++;
        logMatch({
          itemName: entry.itemName,
          searchKeywords: '',
          candidateCount: 1,
          selectedFile: newerVersion.name,
          selectionReason: 'AUTO_UPDATE: 새 버전 ' + newerVersion.name,
          matchMode: 'auto-update'
        });
      }

    } catch (e) {
      errorCount++;
      logError({
        itemName: entry.itemName,
        error: 'AUTO_UPDATE 실패: ' + e.message,
        matchMode: 'auto-update'
      });
    }
  }

  // 업데이트된 결과 저장
  if (updatedCount > 0) {
    saveMatchResults(results.filter(function(r) { return r.fileId; }));
  }

  Logger.log('autoUpdate 완료: ' + updatedCount + '개 갱신, ' + errorCount + '개 에러');
}

function checkFileStatus(fileId) {
  try {
    var file = Drive.Files.get(fileId, {
      fields: 'id, name, parents, trashed',
      supportsAllDrives: true
    });

    if (file.trashed) {
      return { deleted: true };
    }

    return {
      deleted: false,
      currentName: file.name,
      currentParents: file.parents || [],
      nameChanged: false, // 이전 이름과 비교는 entry에서
      parentChanged: false
    };
  } catch (e) {
    if (e.message && e.message.indexOf('404') !== -1) {
      return { deleted: true };
    }
    throw e;
  }
}

function checkForNewerVersion(entry) {
  if (!entry.fileId || !entry.fileName) return null;

  var baseName = extractBaseName(entry.fileName);
  if (!baseName) return null;

  try {
    var file = Drive.Files.get(entry.fileId, {
      fields: 'parents',
      supportsAllDrives: true
    });

    if (!file.parents || file.parents.length === 0) return null;
    var parentId = file.parents[0];

    // 같은 폴더에서 같은 기본명의 파일 검색
    var query = "name contains '" + escapeQuery(baseName) +
      "' and '" + parentId + "' in parents and trashed = false";
    var siblings = executeDriveSearch(query);

    if (siblings.length <= 1) return null;

    // 현재 파일보다 높은 버전이 있는지 확인
    var currentVersion = extractVersion(entry.fileName);
    var newer = null;

    siblings.forEach(function(sib) {
      if (sib.id === entry.fileId) return;
      if (extractBaseName(sib.name) !== baseName) return;

      var sibVersion = extractVersion(sib.name);
      if (sibVersion && currentVersion) {
        if (compareVersions(sibVersion, currentVersion) > 0) {
          if (!newer || compareVersions(sibVersion, extractVersion(newer.name)) > 0) {
            newer = sib;
          }
        }
      } else if (!currentVersion) {
        // 현재 파일에 버전 없으면 수정일 비교
        var sibDate = new Date(sib.modifiedTime || 0);
        var entryDate = new Date(entry.timestamp || 0);
        if (sibDate > entryDate) {
          newer = sib;
        }
      }
    });

    return newer;
  } catch (e) {
    return null;
  }
}

function getResultColFromState() {
  var state = loadState();
  if (state && state.config) return state.config.resultColIndex + 1;
  return 2;
}

function getRemarksColFromState() {
  var state = loadState();
  if (state && state.config && state.config.remarksColIndex >= 0) {
    return state.config.remarksColIndex + 1;
  }
  return -1;
}
