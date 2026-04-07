/**
 * ContentMatcher.gs: 파일 내용 추출 + 문맥 커버리지 매칭 + 페이지 감지
 *
 * 매칭 기준: 검색 기준 컬럼의 핵심 용어 중 80% 이상이 파일 내용에 포함되면 매칭.
 * 페이지 감지: 매칭된 내용이 파일의 몇 페이지에 있는지 추정.
 */

var COVERAGE_THRESHOLD = 0.8; // 80%
var CHARS_PER_PAGE = 2500; // A4 기준 대략적인 페이지당 문자 수

/**
 * 파일 내용을 추출하고, 검색 용어의 커버리지를 계산한다.
 * @param {string} fileId - Drive 파일 ID
 * @param {string[]} searchTerms - 검색 핵심 용어 배열
 * @returns {Object} { coverage, matchedTerms, unmatchedTerms, pages, content }
 */
function calculateCoverage(fileId, searchTerms) {
  if (!searchTerms || searchTerms.length === 0) {
    return { coverage: 0, matchedTerms: [], unmatchedTerms: [], pages: [], content: '' };
  }

  var extracted = extractFileContent(fileId);
  if (!extracted || !extracted.content) {
    return { coverage: 0, matchedTerms: [], unmatchedTerms: searchTerms, pages: [], content: '' };
  }

  var contentLower = extracted.content.toLowerCase();
  var matchedTerms = [];
  var unmatchedTerms = [];
  var matchPositions = []; // 매칭된 용어의 위치 (페이지 계산용)

  searchTerms.forEach(function(term) {
    var termLower = term.toLowerCase().trim();
    if (!termLower || termLower.length < 2) return;

    var pos = contentLower.indexOf(termLower);
    if (pos !== -1) {
      matchedTerms.push(term);
      matchPositions.push(pos);
    } else {
      unmatchedTerms.push(term);
    }
  });

  var coverage = searchTerms.length > 0 ? matchedTerms.length / searchTerms.length : 0;

  // 페이지 감지
  var pages = detectPages(matchPositions, extracted);

  return {
    coverage: coverage,
    coveragePercent: Math.round(coverage * 100),
    matchedTerms: matchedTerms,
    unmatchedTerms: unmatchedTerms,
    matchedCount: matchedTerms.length,
    totalTerms: searchTerms.length,
    pages: pages,
    pageString: formatPages(pages)
  };
}

/**
 * 검색 내용에서 핵심 용어를 추출한다.
 * 단순 키워드가 아닌, 의미 있는 용어 단위로 분리.
 */
function extractSearchTerms(content) {
  if (!content) return [];
  var text = String(content).trim();

  // 불용어
  var stopWords = [
    '및', '또는', '위한', '대한', '관련', '포함', '기반', '통한', '따른', '있는', '없는', '하는', '되는', '된다',
    '에서', '으로', '에게', '까지', '부터', '의', '을', '를', '이', '가', '은', '는', '와', '과', '도', '만',
    'the', 'and', 'or', 'for', 'of', 'in', 'to', 'a', 'an', 'is', 'are', 'be', 'with', 'that', 'this'
  ];

  // 공백/특수문자로 분리, 2자 이상, 불용어 제거
  var words = text.split(/[\s,;·\/\(\)\[\]\{\}「」『』<>]+/)
    .map(function(w) { return w.replace(/^[.\-_]+|[.\-_]+$/g, '').trim(); })
    .filter(function(w) { return w.length >= 2; })
    .filter(function(w) { return stopWords.indexOf(w.toLowerCase()) === -1; });

  // 중복 제거
  var unique = [];
  var seen = {};
  words.forEach(function(w) {
    var key = w.toLowerCase();
    if (!seen[key]) {
      seen[key] = true;
      unique.push(w);
    }
  });

  return unique;
}

/**
 * 파일 내용을 텍스트로 추출한다.
 * @returns {Object} { content, type, pageBreaks[] }
 */
function extractFileContent(fileId) {
  try {
    var file = Drive.Files.get(fileId, {
      fields: 'id, name, mimeType',
      supportsAllDrives: true
    });

    var mimeType = file.mimeType;

    // Google Docs
    if (mimeType === 'application/vnd.google-apps.document') {
      return extractGoogleDocsContent(fileId);
    }

    // Google Slides
    if (mimeType === 'application/vnd.google-apps.presentation') {
      return extractGoogleSlidesContent(fileId);
    }

    // Google Sheets
    if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      return extractGoogleSheetsContent(fileId);
    }

    // PDF — Drive가 인덱싱한 텍스트를 추출 시도
    if (mimeType === 'application/pdf') {
      return extractPdfContent(fileId);
    }

    // MS Office (Word, PowerPoint, Excel) — Drive가 변환한 텍스트 추출
    if (mimeType.indexOf('officedocument') !== -1 ||
        mimeType === 'application/msword' ||
        mimeType === 'application/vnd.ms-excel' ||
        mimeType === 'application/vnd.ms-powerpoint') {
      return extractOfficeContent(fileId, mimeType);
    }

    // 기타 텍스트 파일
    if (mimeType.indexOf('text/') === 0) {
      return extractPlainTextContent(fileId);
    }

    return null;
  } catch (e) {
    Logger.log('파일 내용 추출 실패 (' + fileId + '): ' + e.message);
    return null;
  }
}

function extractGoogleDocsContent(fileId) {
  try {
    var doc = DocumentApp.openById(fileId);
    var body = doc.getBody();
    var text = body.getText();
    return {
      content: text,
      type: 'docs',
      totalChars: text.length
    };
  } catch (e) {
    // DocumentApp 권한 없으면 export로 시도
    try {
      var url = 'https://docs.google.com/document/d/' + fileId + '/export?format=txt';
      var response = UrlFetchApp.fetch(url, {
        headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      });
      if (response.getResponseCode() === 200) {
        var text = response.getContentText();
        return { content: text, type: 'docs', totalChars: text.length };
      }
    } catch (e2) {}
    return null;
  }
}

function extractGoogleSlidesContent(fileId) {
  try {
    var presentation = SlidesApp.openById(fileId);
    var slides = presentation.getSlides();
    var pages = [];
    var allText = '';

    slides.forEach(function(slide, idx) {
      var slideText = '';
      slide.getShapes().forEach(function(shape) {
        if (shape.getText) {
          var text = shape.getText().asString();
          if (text) slideText += text + ' ';
        }
      });
      pages.push({
        pageNum: idx + 1,
        startPos: allText.length,
        text: slideText.trim()
      });
      allText += slideText;
    });

    return {
      content: allText,
      type: 'slides',
      slidePages: pages,
      totalChars: allText.length
    };
  } catch (e) {
    return null;
  }
}

function extractGoogleSheetsContent(fileId) {
  try {
    var ss = SpreadsheetApp.openById(fileId);
    var sheets = ss.getSheets();
    var allText = '';
    var pages = [];

    sheets.forEach(function(sheet, idx) {
      var data = sheet.getDataRange().getValues();
      var sheetText = data.map(function(row) {
        return row.join(' ');
      }).join(' ');
      pages.push({
        pageNum: idx + 1,
        startPos: allText.length,
        text: sheetText,
        sheetName: sheet.getName()
      });
      allText += sheetText + ' ';
    });

    return {
      content: allText,
      type: 'sheets',
      sheetPages: pages,
      totalChars: allText.length
    };
  } catch (e) {
    return null;
  }
}

function extractPdfContent(fileId) {
  try {
    // PDF를 Google Docs로 변환하여 텍스트 추출
    var blob = DriveApp.getFileById(fileId).getBlob();
    var resource = { title: '_temp_pdf_extract_', mimeType: 'application/vnd.google-apps.document' };
    var options = { ocr: true };
    var tempDoc = Drive.Files.copy(resource, fileId, { ocrLanguage: 'ko' });
    var text = DocumentApp.openById(tempDoc.id).getBody().getText();
    DriveApp.getFileById(tempDoc.id).setTrashed(true); // 임시 파일 삭제

    return { content: text, type: 'pdf', totalChars: text.length };
  } catch (e) {
    // 변환 실패 시 null
    return null;
  }
}

function extractOfficeContent(fileId, mimeType) {
  try {
    // Office 파일을 Google 포맷으로 export하여 텍스트 추출
    var exportMime = 'text/plain';
    var url = 'https://www.googleapis.com/drive/v3/files/' + fileId + '/export?mimeType=' + encodeURIComponent(exportMime);
    var response = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() === 200) {
      var text = response.getContentText();
      return { content: text, type: 'office', totalChars: text.length };
    }
    return null;
  } catch (e) {
    return null;
  }
}

function extractPlainTextContent(fileId) {
  try {
    var file = DriveApp.getFileById(fileId);
    var text = file.getBlob().getDataAsString();
    return { content: text, type: 'text', totalChars: text.length };
  } catch (e) {
    return null;
  }
}

/**
 * 매칭된 위치로부터 페이지 번호를 감지한다.
 */
function detectPages(matchPositions, extracted) {
  if (!matchPositions || matchPositions.length === 0 || !extracted) return [];

  var pages = [];

  // Google Slides: 슬라이드 번호로 직접 매핑
  if (extracted.type === 'slides' && extracted.slidePages) {
    matchPositions.forEach(function(pos) {
      for (var i = extracted.slidePages.length - 1; i >= 0; i--) {
        if (pos >= extracted.slidePages[i].startPos) {
          var slideNum = extracted.slidePages[i].pageNum;
          if (pages.indexOf(slideNum) === -1) pages.push(slideNum);
          break;
        }
      }
    });
    pages.sort(function(a, b) { return a - b; });
    return pages;
  }

  // Google Sheets: 시트 번호로 매핑
  if (extracted.type === 'sheets' && extracted.sheetPages) {
    matchPositions.forEach(function(pos) {
      for (var i = extracted.sheetPages.length - 1; i >= 0; i--) {
        if (pos >= extracted.sheetPages[i].startPos) {
          var sheetName = extracted.sheetPages[i].sheetName;
          if (pages.indexOf(sheetName) === -1) pages.push(sheetName);
          break;
        }
      }
    });
    return pages;
  }

  // Google Docs / PDF / Office: 문자 위치 기반 추정
  matchPositions.forEach(function(pos) {
    var pageNum = Math.floor(pos / CHARS_PER_PAGE) + 1;
    if (pages.indexOf(pageNum) === -1) pages.push(pageNum);
  });
  pages.sort(function(a, b) { return a - b; });
  return pages;
}

/**
 * 페이지 배열을 사람이 읽기 좋은 문자열로 변환한다.
 */
function formatPages(pages) {
  if (!pages || pages.length === 0) return '';

  // 시트명(문자열)인 경우
  if (typeof pages[0] === 'string') {
    return '시트: ' + pages.join(', ');
  }

  // 연속 페이지 압축 (예: [1,2,3,5,7,8] → "p.1-3, 5, 7-8")
  var ranges = [];
  var start = pages[0];
  var end = pages[0];

  for (var i = 1; i < pages.length; i++) {
    if (pages[i] === end + 1) {
      end = pages[i];
    } else {
      ranges.push(start === end ? 'p.' + start : 'p.' + start + '-' + end);
      start = pages[i];
      end = pages[i];
    }
  }
  ranges.push(start === end ? 'p.' + start : 'p.' + start + '-' + end);

  return ranges.join(', ');
}
