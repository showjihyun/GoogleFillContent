/**
 * FolderTree.gs: 폴더 트리 재귀 수집, 경로 캐시, 시간 체크 + continuation
 */

var TIME_LIMIT_MS = 300000; // 5분

function collectSubfolders(rootId, startTime, existingState) {
  var queue = existingState ? existingState.queue : [rootId];
  var allFolderIds = existingState ? existingState.allFolderIds : [rootId];
  var pathMap = existingState ? existingState.pathMap : {};

  if (!existingState) {
    try {
      var rootFolder = DriveApp.getFolderById(rootId);
      pathMap[rootId] = rootFolder.getName();
    } catch (e) {
      pathMap[rootId] = 'Root';
    }
  }

  while (queue.length > 0) {
    if (Date.now() - startTime > TIME_LIMIT_MS) {
      var state = loadState();
      state.treeState = {
        queue: queue,
        allFolderIds: allFolderIds,
        pathMap: pathMap
      };
      state.phase = 'TREE_COLLECTION';
      saveState(state);
      scheduleContinuation(60000);
      return null;
    }

    var currentId = queue.shift();
    try {
      var children = listChildFolders(currentId);
      children.forEach(function(child) {
        if (allFolderIds.indexOf(child.id) === -1) {
          allFolderIds.push(child.id);
          queue.push(child.id);
          pathMap[child.id] = (pathMap[currentId] || '') + '/' + child.name;
        }
      });
    } catch (e) {
      logError({
        itemName: 'FolderTree',
        error: '폴더 접근 실패: ' + currentId + ' - ' + e.message,
        matchMode: 'tree'
      });
    }
  }

  if (allFolderIds.length > 100) {
    Logger.log('WARNING: 폴더 ' + allFolderIds.length + '개 — 검색이 느릴 수 있습니다');
  }

  return {
    folderIds: allFolderIds,
    pathMap: pathMap
  };
}

function listChildFolders(parentId) {
  var folders = [];
  var pageToken = null;
  do {
    var params = {
      q: "'" + parentId + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      pageSize: 100,
      fields: 'nextPageToken, files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    };
    if (pageToken) params.pageToken = pageToken;
    var response = Drive.Files.list(params);
    var files = response.files || [];
    files.forEach(function(f) {
      folders.push({ id: f.id, name: f.name });
    });
    pageToken = response.nextPageToken;
  } while (pageToken);
  return folders;
}

function getFilePath(fileId, pathMap) {
  try {
    var file = DriveApp.getFileById(fileId);
    var parents = file.getParents();
    if (parents.hasNext()) {
      var parentId = parents.next().getId();
      if (pathMap[parentId]) {
        return pathMap[parentId] + '/' + file.getName();
      }
    }
    return file.getName();
  } catch (e) {
    return '(경로 확인 불가)';
  }
}

function getFileUrl(fileId) {
  return 'https://drive.google.com/file/d/' + fileId + '/view';
}
