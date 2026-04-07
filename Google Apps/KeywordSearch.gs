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

  // 커버리지 80% 검증: 검색 기준 컬럼 내용의 핵심 용어 중 80% 이상 포함된 파일만 매칭
  var searchTerms = extractSearchTerms(itemContent);
  var verifiedFiles = [];

  allFiles.forEach(function(file) {
    var result = calculateCoverage(file.id, searchTerms);
    if (result.coverage >= COVERAGE_THRESHOLD) {
      file._coverage = result;
      verifiedFiles.push(file);
    }
  });

  return { files: verifiedFiles, keywords: keywords, searchTerms: searchTerms };
}

/**
 * 키워드 검색으로 후보만 수집 (커버리지 검증 생략).
 * keyword_then_ai 모드에서 사용 — AI가 최종 판정하므로 넓게 수집.
 */
function searchByKeywordRaw(itemContent, folderIds) {
  var keywords = extractKeywordsFromContent(itemContent);
  if (keywords.length === 0) {
    return { files: [], keywords: [], error: '키워드를 추출할 수 없습니다' };
  }

  var allFiles = [];
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

/**
 * 키워드로 수집한 후보를 AI(Gemini)로 관련도 검증.
 * 70점 이상 + 커버리지 80% 통과 파일만 반환.
 */
function verifyWithAI(itemContent, keywordResult, cachedContext) {
  var apiKey = getGeminiApiKey();
  if (!apiKey) {
    // API 키 없으면 커버리지 검증만으로 fallback
    var searchTerms = extractSearchTerms(itemContent);
    var verified = [];
    (keywordResult.files || []).forEach(function(file) {
      var result = calculateCoverage(file.id, searchTerms);
      if (result.coverage >= COVERAGE_THRESHOLD) {
        file._coverage = result;
        verified.push(file);
      }
    });
    return { files: verified, keywords: keywordResult.keywords, searchTerms: searchTerms, fallback: true };
  }

  var candidates = (keywordResult.files || []).slice(0, 10);
  if (candidates.length === 0) {
    return { files: [], keywords: keywordResult.keywords };
  }

  // 캐시된 문맥이 있으면 문맥 기반 평가, 없으면 기본 평가
  var context = cachedContext || { documentType: '', purpose: '' };
  var scored;
  try {
    scored = evaluateWithContext(itemContent, context, candidates, apiKey);
  } catch (e) {
    // AI 평가 실패 → 커버리지만으로 판정
    var searchTerms = extractSearchTerms(itemContent);
    var verified = [];
    candidates.forEach(function(file) {
      var result = calculateCoverage(file.id, searchTerms);
      if (result.coverage >= COVERAGE_THRESHOLD) {
        file._coverage = result;
        verified.push(file);
      }
    });
    return { files: verified, keywords: keywordResult.keywords, searchTerms: searchTerms, message: 'AI 검증 실패, 커버리지만 사용' };
  }

  var matched = scored.filter(function(s) { return s.score >= RELEVANCE_THRESHOLD; });

  // AI 통과 후보에 커버리지 + 페이지 감지
  var searchTerms = extractSearchTerms(itemContent);
  var verifiedFiles = [];
  matched.forEach(function(s) {
    var coverageResult = calculateCoverage(s.file.id, searchTerms);
    s.file._coverage = coverageResult;
    verifiedFiles.push(s.file);
  });

  return {
    files: verifiedFiles,
    keywords: keywordResult.keywords,
    scores: scored,
    searchTerms: searchTerms
  };
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
