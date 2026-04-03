/**
 * KeywordSearch.gs: Drive API fullText 기반 키워드 검색 전략
 * 페이지네이션 + 폴더 필터링 포함
 */

function searchByKeyword(itemContent, folderIds) {
  var keywords = extractKeywordsFromContent(itemContent);
  if (keywords.length === 0) {
    return { files: [], keywords: [], error: '키워드를 추출할 수 없습니다' };
  }

  var allFiles = [];

  // 키워드별로 검색 후 합산
  for (var k = 0; k < keywords.length; k++) {
    var keyword = keywords[k].trim();
    if (!keyword || keyword.length < 2) continue;

    var files = searchDriveFullText(keyword, folderIds);
    files.forEach(function(file) {
      if (!allFiles.some(function(f) { return f.id === file.id; })) {
        allFiles.push(file);
      }
    });
  }

  return { files: allFiles, keywords: keywords };
}

function extractKeywordsFromContent(content) {
  if (!content) return [];
  var text = String(content).trim();

  // 불용어 제거
  var stopWords = ['및', '또는', '위한', '대한', '관련', '포함', '기반', '통한',
                   '에서', '으로', '에게', '까지', '부터', '의', '을', '를', '이', '가',
                   'the', 'and', 'or', 'for', 'of', 'in', 'to', 'a', 'an', 'is', 'are'];

  // 공백/특수문자로 분리 후 2자 이상만
  var words = text.split(/[\s,;·\/\(\)\[\]]+/)
    .filter(function(w) { return w.length >= 2; })
    .filter(function(w) { return stopWords.indexOf(w.toLowerCase()) === -1; });

  // 중복 제거
  var unique = [];
  words.forEach(function(w) {
    if (unique.indexOf(w) === -1) unique.push(w);
  });

  // 최대 5개
  return unique.slice(0, 5);
}

function searchDriveFullText(keyword, folderIds) {
  var allFiles = [];

  // folderIds를 20개씩 묶어서 쿼리 (Drive API 쿼리 길이 제한 대응)
  var chunkSize = 20;
  for (var i = 0; i < folderIds.length; i += chunkSize) {
    var chunk = folderIds.slice(i, i + chunkSize);
    var parentClause = chunk.map(function(id) {
      return "'" + id + "' in parents";
    }).join(' or ');

    var query = "fullText contains '" + escapeQuery(keyword) + "' and (" + parentClause + ") and trashed = false";

    var files = executeDriveSearch(query);
    files.forEach(function(file) {
      if (!allFiles.some(function(f) { return f.id === file.id; })) {
        allFiles.push(file);
      }
    });
  }

  // fullText 검색 결과가 없으면 파일명 검색으로 fallback
  if (allFiles.length === 0) {
    allFiles = searchDriveByName(keyword, folderIds);
  }

  return allFiles;
}

function searchDriveByName(keyword, folderIds) {
  var allFiles = [];
  var chunkSize = 20;
  for (var i = 0; i < folderIds.length; i += chunkSize) {
    var chunk = folderIds.slice(i, i + chunkSize);
    var parentClause = chunk.map(function(id) {
      return "'" + id + "' in parents";
    }).join(' or ');

    var query = "name contains '" + escapeQuery(keyword) + "' and (" + parentClause + ") and trashed = false";
    var files = executeDriveSearch(query);
    files.forEach(function(file) {
      if (!allFiles.some(function(f) { return f.id === file.id; })) {
        allFiles.push(file);
      }
    });
  }
  return allFiles;
}

function executeDriveSearch(query) {
  var allFiles = [];
  var pageToken = null;
  var retryCount = 0;

  do {
    try {
      var params = {
        q: query,
        pageSize: 100,
        fields: 'nextPageToken, files(id, name, modifiedTime, parents, mimeType, description)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      };
      if (pageToken) params.pageToken = pageToken;

      var response = Drive.Files.list(params);
      var files = response.files || [];
      allFiles = allFiles.concat(files);
      pageToken = response.nextPageToken;
      retryCount = 0;
    } catch (e) {
      retryCount++;
      if (retryCount >= 3) {
        Logger.log('Drive API 검색 실패 (3회 재시도 후): ' + e.message);
        break;
      }
      Utilities.sleep(2000 * retryCount);
    }
  } while (pageToken);

  return allFiles;
}

function escapeQuery(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
