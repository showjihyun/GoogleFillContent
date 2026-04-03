/**
 * AISearch.gs: Gemini API 기반 AI 검색 전략
 * 키워드 추출 + 관련도 평가
 */

var GEMINI_MODEL = 'gemini-2.5-flash';
var GEMINI_TIMEOUT_MS = 30000;
var RELEVANCE_THRESHOLD = 70;

function searchByAI(itemContent, folderIds) {
  var apiKey = getGeminiApiKey();
  if (!apiKey) {
    return { files: [], keywords: [], error: 'AI_FALLBACK', message: 'Gemini API 키가 설정되지 않았습니다' };
  }

  // Step 1: Gemini로 키워드 추출
  var keywords;
  try {
    keywords = extractKeywordsWithGemini(itemContent, apiKey);
  } catch (e) {
    return { files: [], keywords: [], error: 'AI_FALLBACK', message: 'AI 키워드 추출 실패: ' + e.message };
  }

  if (!keywords || keywords.length === 0) {
    return { files: [], keywords: [], error: 'AI_FALLBACK', message: 'AI가 키워드를 추출하지 못했습니다' };
  }

  // Step 2: 추출된 키워드로 Drive 검색
  var allFiles = [];
  keywords.forEach(function(keyword) {
    var files = searchDriveFullText(keyword, folderIds);
    files.forEach(function(file) {
      if (!allFiles.some(function(f) { return f.id === file.id; })) {
        allFiles.push(file);
      }
    });
  });

  if (allFiles.length === 0) {
    return { files: [], keywords: keywords, error: null };
  }

  // Step 3: 후보를 최대 10개로 제한 후 관련도 평가
  var candidates = allFiles.slice(0, 10);
  var scored;
  try {
    scored = evaluateRelevanceWithGemini(itemContent, candidates, apiKey);
  } catch (e) {
    return { files: candidates, keywords: keywords, error: null, scores: null, message: 'AI 관련도 평가 실패 — 파일명 기반으로 진행' };
  }

  // Step 4: 70점 이상 필터링
  var matched = scored.filter(function(s) { return s.score >= RELEVANCE_THRESHOLD; });

  // Step 5: 커버리지 80% 검증 + 페이지 감지
  var searchTerms = extractSearchTerms(itemContent);
  var verifiedFiles = [];

  matched.forEach(function(s) {
    var coverageResult = calculateCoverage(s.file.id, searchTerms);
    if (coverageResult.coverage >= COVERAGE_THRESHOLD) {
      s.file._coverage = coverageResult;
      verifiedFiles.push(s.file);
    }
  });

  return {
    files: verifiedFiles,
    keywords: keywords,
    scores: scored,
    searchTerms: searchTerms,
    error: null
  };
}

function extractKeywordsWithGemini(itemContent, apiKey) {
  var prompt = '다음 매뉴얼 항목의 내용을 분석하여, 관련 산출물 파일을 ' +
    'Google Drive에서 검색하기 위한 핵심 키워드 3-5개를 추출하세요.\n' +
    '키워드는 한국어와 영어 모두 포함 가능합니다.\n' +
    'JSON 배열로만 응답하세요: ["키워드1", "키워드2", ...]\n' +
    '항목: ' + String(itemContent);

  var responseText = callGeminiApi(prompt, apiKey);
  return parseJsonArray(responseText);
}

function evaluateRelevanceWithGemini(itemContent, candidates, apiKey) {
  var fileList = candidates.map(function(f, i) {
    return (i + 1) + '. ' + f.name + (f.description ? ' - ' + f.description : '');
  }).join('\n');

  var prompt = '매뉴얼 항목과 파일 후보들의 관련도를 0-100 점수로 평가하세요.\n' +
    '70점 이상: 확실히 관련 있음\n' +
    '50-69점: 부분적으로 관련\n' +
    '50점 미만: 관련 없음\n' +
    'JSON 배열로만 응답: [{"index": 1, "score": N, "reason": "한줄설명"}, ...]\n\n' +
    '매뉴얼 항목: ' + String(itemContent) + '\n\n' +
    '파일 후보:\n' + fileList;

  var responseText = callGeminiApi(prompt, apiKey);
  var scores = parseJsonArray(responseText);

  return scores.map(function(s) {
    var idx = (s.index || 1) - 1;
    if (idx >= 0 && idx < candidates.length) {
      return {
        file: candidates[idx],
        score: s.score || 0,
        reason: s.reason || ''
      };
    }
    return null;
  }).filter(function(s) { return s !== null; });
}

function callGeminiApi(prompt, apiKey) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    GEMINI_MODEL + ':generateContent?key=' + apiKey;

  var payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json'
    }
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();

  if (code === 429) {
    throw new Error('Gemini API 쿼터 초과 — 잠시 후 재시도하세요');
  }
  if (code !== 200) {
    throw new Error('Gemini API 에러 (HTTP ' + code + '): ' + response.getContentText().substring(0, 200));
  }

  var json = JSON.parse(response.getContentText());
  var text = json.candidates &&
    json.candidates[0] &&
    json.candidates[0].content &&
    json.candidates[0].content.parts &&
    json.candidates[0].content.parts[0] &&
    json.candidates[0].content.parts[0].text;

  if (!text) throw new Error('Gemini API 응답이 비어 있습니다');
  return text;
}

function parseJsonArray(text) {
  if (!text) return [];
  try {
    var cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (e) {
    var match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { return []; }
    }
    return [];
  }
}
