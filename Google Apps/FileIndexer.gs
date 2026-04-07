/**
 * FileIndexer.gs: 폴더 내 전체 파일 목록 수집 + 페이지 단위 내용 인덱스 구축
 *
 * 매칭 흐름:
 *   1. 폴더의 모든 파일 메타데이터 수집
 *   2. 파일별 내용을 페이지 단위로 추출 (요약)
 *   3. 관련 내용 발견 시 해당 파일은 Continue (전체 안 읽음)
 *   4. 인덱스를 Gemini에 전달하여 일괄 매칭
 */

var PAGE_SUMMARY_LENGTH = 300; // 페이지당 요약 길이
var MAX_PAGES_PER_FILE = 50;   // 파일당 최대 페이지 수

/**
 * 폴더 내 모든 파일의 메타데이터를 수집한다.
 * @param {string[]} folderIds - 폴더 ID 배열
 * @returns {Object[]} 파일 메타데이터 배열
 */
function collectAllFiles(folderIds) {
  var allFiles = [];
  var seenIds = {};

  folderIds.forEach(function(folderId) {
    var pageToken = null;
    do {
      try {
        var params = {
          q: "'" + folderId + "' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'",
          pageSize: 100,
          fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, description)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        };
        if (pageToken) params.pageToken = pageToken;
        var response = Drive.Files.list(params);
        (response.files || []).forEach(function(f) {
          if (!seenIds[f.id]) {
            seenIds[f.id] = true;
            allFiles.push(f);
          }
        });
        pageToken = response.nextPageToken;
      } catch (e) {
        Logger.log('파일 수집 실패 (폴더: ' + folderId + '): ' + e.message);
        pageToken = null;
      }
    } while (pageToken);
  });

  return allFiles;
}

/**
 * 파일의 내용을 페이지 단위로 인덱싱한다.
 * 각 항목(searchItems)과 대조하여, 관련 내용이 발견되면 해당 파일은 Continue.
 *
 * @param {Object} file - 파일 메타데이터 {id, name, mimeType}
 * @param {string[]} searchItems - 검색 기준 항목 내용 배열 (전체)
 * @param {number} startTime - 시작 시간 (시간 체크용)
 * @returns {Object} { pages: [{pageNum, summary, matchedItems}], fullyIndexed }
 */
function indexFileContent(file, searchItems, startTime) {
  var result = { fileId: file.id, fileName: file.name, pages: [], fullyIndexed: false };

  try {
    var extracted = extractFileContent(file.id);
    if (!extracted || !extracted.content) {
      return result;
    }

    var pages = splitIntoPages(extracted);

    for (var p = 0; p < pages.length && p < MAX_PAGES_PER_FILE; p++) {
      // 시간 체크
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        return result; // 시간 초과 — 지금까지 인덱싱한 것만 반환
      }

      var page = pages[p];
      var summary = page.text.substring(0, PAGE_SUMMARY_LENGTH);

      // 이 페이지가 어떤 항목과 관련있는지 빠르게 체크
      var matchedItems = quickMatchPage(page.text, searchItems);

      result.pages.push({
        pageNum: page.pageNum,
        pageLabel: page.pageLabel || ('p.' + page.pageNum),
        summary: summary,
        matchedItemIndices: matchedItems,
        hasMatch: matchedItems.length > 0
      });

      // 모든 항목에 대해 매칭이 발견되었으면 Continue (나머지 페이지 안 읽음)
      // 단, 최소 3페이지는 읽어야 함 (목차 등 초반 페이지는 의미 없을 수 있으므로)
      if (p >= 2 && matchedItems.length > 0) {
        var totalMatched = {};
        result.pages.forEach(function(pg) {
          pg.matchedItemIndices.forEach(function(idx) { totalMatched[idx] = true; });
        });
        // 매칭된 항목이 있으면 이 파일은 충분히 인덱싱됨
        if (Object.keys(totalMatched).length > 0) {
          result.fullyIndexed = true;
          return result;
        }
      }
    }

    result.fullyIndexed = true;
  } catch (e) {
    Logger.log('파일 인덱싱 실패 (' + file.name + '): ' + e.message);
  }

  return result;
}

/**
 * 추출된 파일 내용을 페이지 단위로 분할한다.
 */
function splitIntoPages(extracted) {
  var pages = [];

  // Google Slides: 슬라이드 단위
  if (extracted.type === 'slides' && extracted.slidePages) {
    extracted.slidePages.forEach(function(slide) {
      pages.push({
        pageNum: slide.pageNum,
        pageLabel: '슬라이드 ' + slide.pageNum,
        text: slide.text
      });
    });
    return pages;
  }

  // Google Sheets: 시트 단위
  if (extracted.type === 'sheets' && extracted.sheetPages) {
    extracted.sheetPages.forEach(function(sheet) {
      pages.push({
        pageNum: sheet.pageNum,
        pageLabel: '시트: ' + sheet.sheetName,
        text: sheet.text
      });
    });
    return pages;
  }

  // Docs/PDF/Office: 문자 수 기반 페이지 분할
  var text = extracted.content;
  var pageSize = CHARS_PER_PAGE;
  var pageNum = 1;

  for (var i = 0; i < text.length; i += pageSize) {
    var pageText = text.substring(i, Math.min(i + pageSize, text.length));
    pages.push({
      pageNum: pageNum,
      pageLabel: 'p.' + pageNum,
      text: pageText
    });
    pageNum++;
  }

  return pages;
}

/**
 * 페이지 내용과 검색 항목들을 빠르게 대조한다.
 * 항목 내용의 핵심 단어가 페이지에 포함되어 있으면 매칭 후보.
 * (정밀 매칭은 Gemini가 담당 — 여기서는 후보 필터링만)
 *
 * @returns {number[]} 매칭된 항목 인덱스 배열
 */
function quickMatchPage(pageText, searchItems) {
  var pageLower = pageText.toLowerCase();
  var matched = [];

  searchItems.forEach(function(item, idx) {
    if (!item) return;
    var terms = extractSearchTerms(item);
    if (terms.length === 0) return;

    // 핵심 단어 중 30% 이상 포함되면 후보로 판단 (느슨한 기준 — Gemini가 최종 판정)
    var hitCount = 0;
    terms.forEach(function(term) {
      if (pageLower.indexOf(term.toLowerCase()) !== -1) hitCount++;
    });

    if (terms.length > 0 && hitCount / terms.length >= 0.3) {
      matched.push(idx);
    }
  });

  return matched;
}

/**
 * 파일 인덱스를 Gemini에 전달할 수 있는 콤팩트한 형태로 변환한다.
 * @param {Object[]} fileIndices - indexFileContent() 결과 배열
 * @returns {string} Gemini 프롬프트에 포함할 파일 인덱스 텍스트
 */
function formatFileIndex(fileIndices) {
  return fileIndices.map(function(fi, i) {
    var fileHeader = '[파일 ' + (i + 1) + '] ' + fi.fileName;
    if (fi.pages.length === 0) {
      return fileHeader + '\n  (내용 추출 불가)';
    }

    var pageDetails = fi.pages.map(function(pg) {
      var line = '  ' + pg.pageLabel + ': ' + pg.summary;
      if (pg.summary.length >= PAGE_SUMMARY_LENGTH) line += '...';
      return line;
    }).join('\n');

    return fileHeader + '\n' + pageDetails;
  }).join('\n\n');
}

/**
 * 전체 매칭 실행: 파일 인덱스 + 시트 항목을 Gemini에 전달하여 일괄 매칭.
 * @param {string[]} searchItems - 시트의 검색 기준 항목 내용 배열
 * @param {Object[]} fileIndices - 파일 인덱스 배열
 * @param {Object} matchingPlan - 시트 전체 분석 결과 (있을 경우)
 * @param {string} apiKey - Gemini API 키
 * @returns {Object[]} [{itemIndex, fileIndex, fileName, fileId, page, score, reason}, ...]
 */
function geminiMatchAll(searchItems, fileIndices, matchingPlan, apiKey) {
  var itemList = searchItems.map(function(item, i) {
    return '[항목 ' + (i + 1) + '] ' + (item || '(빈 항목)').substring(0, 200);
  }).join('\n');

  var fileIndex = formatFileIndex(fileIndices);

  // 파일 인덱스가 너무 크면 페이지 요약을 축약
  if (fileIndex.length > 30000) {
    fileIndex = fileIndices.map(function(fi, i) {
      var header = '[파일 ' + (i + 1) + '] ' + fi.fileName;
      if (fi.pages.length === 0) return header + ' (내용 없음)';
      var firstPages = fi.pages.slice(0, 3).map(function(pg) {
        return '  ' + pg.pageLabel + ': ' + pg.summary.substring(0, 150) + '...';
      }).join('\n');
      return header + ' (' + fi.pages.length + '페이지)\n' + firstPages;
    }).join('\n\n');
  }

  var planContext = '';
  if (matchingPlan && matchingPlan.domain) {
    planContext =
      '프로젝트 도메인: ' + matchingPlan.domain + '\n' +
      '프로젝트 유형: ' + (matchingPlan.projectType || '') + '\n' +
      '생명주기: ' + (matchingPlan.lifecycle || '') + '\n\n';
  }

  var prompt =
    '당신은 프로젝트 산출물 매칭 전문가입니다.\n\n' +
    planContext +
    '아래 매뉴얼 항목 목록과 파일 목록(내용 포함)을 보고,\n' +
    '각 항목에 가장 적합한 파일과 페이지를 매칭하세요.\n\n' +
    '=== 매칭 규칙 ===\n' +
    '1. 파일명뿐 아니라 파일 내용(페이지별 요약)을 보고 판단하세요.\n' +
    '2. 유사어는 동일: 운영자=운용자=관리자, 매뉴얼=가이드=안내서=지침서\n' +
    '3. 항목이 직접 언급하는 문서가 있으면 ("XXX 별도 존재/참조") 해당 파일 우선.\n' +
    '4. 매칭할 파일이 없으면 null로 표시.\n' +
    '5. 한 파일이 여러 항목에 매칭될 수 있음.\n' +
    '6. 페이지 번호는 관련 내용이 있는 페이지를 명시.\n\n' +
    '=== 매뉴얼 항목 (' + searchItems.length + '개) ===\n' +
    itemList + '\n\n' +
    '=== 파일 목록 + 내용 (' + fileIndices.length + '개) ===\n' +
    fileIndex + '\n\n' +
    'JSON 배열로 응답하세요. 모든 항목에 대해 응답:\n' +
    '[\n' +
    '  {"itemIndex": 1, "fileIndex": 3, "page": "p.5", "score": 85, "reason": "매칭 이유 한 줄"},\n' +
    '  {"itemIndex": 2, "fileIndex": null, "page": null, "score": 0, "reason": "관련 파일 없음"},\n' +
    '  ...\n' +
    ']\n\n' +
    'score 기준:\n' +
    '80-100: 확실한 매칭\n' +
    '60-79: 높은 관련성\n' +
    '0-59: 매칭 아님 (fileIndex를 null로)';

  var responseText = callGeminiApi(prompt, apiKey);
  var matches = parseJsonArray(responseText);

  // 결과에 파일 정보 매핑
  return matches.map(function(m) {
    var fi = (m.fileIndex != null && m.fileIndex >= 1 && m.fileIndex <= fileIndices.length)
      ? fileIndices[m.fileIndex - 1]
      : null;
    return {
      itemIndex: (m.itemIndex || 1) - 1, // 0-based로 변환
      fileId: fi ? fi.fileId : null,
      fileName: fi ? fi.fileName : null,
      page: m.page || null,
      score: m.score || 0,
      reason: m.reason || ''
    };
  });
}

/**
 * 항목 수나 파일 수가 많으면 청크로 나눠서 매칭한다.
 * Gemini 컨텍스트 한도를 고려하여 적절히 분할.
 */
function geminiMatchAllChunked(searchItems, fileIndices, matchingPlan, apiKey, startTime) {
  // 파일 20개 이하 + 항목 30개 이하면 한번에 처리
  if (fileIndices.length <= 20 && searchItems.length <= 30) {
    return geminiMatchAll(searchItems, fileIndices, matchingPlan, apiKey);
  }

  // 항목을 20개씩 나눠서 처리 (파일 목록은 전체 전달)
  var allMatches = [];
  var chunkSize = 20;

  for (var i = 0; i < searchItems.length; i += chunkSize) {
    if (Date.now() - startTime > TIME_LIMIT_MS) {
      break; // 시간 초과 — 지금까지 매칭된 것만 반환
    }

    var chunk = searchItems.slice(i, i + chunkSize);
    var chunkMatches = geminiMatchAll(chunk, fileIndices, matchingPlan, apiKey);

    // 인덱스를 원래 위치로 보정
    chunkMatches.forEach(function(m) {
      m.itemIndex = m.itemIndex + i;
      allMatches.push(m);
    });
  }

  return allMatches;
}
