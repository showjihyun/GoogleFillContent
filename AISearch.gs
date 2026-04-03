/**
 * AISearch.gs: Gemini API 기반 문맥 이해 AI 검색
 *
 * 기존 방식: 키워드 추출 → Drive 검색 → 관련도 평가 (키워드 매칭과 큰 차이 없음)
 * 새 방식:
 *   1단계: 문맥 분석 — 항목이 요구하는 산출물의 종류/목적/예상 파일명 패턴 이해
 *   2단계: 다중 전략 검색 — 파일명 검색 + fullText 검색 + 유사어 검색
 *   3단계: 문맥 기반 매칭 — 후보 파일의 내용을 읽고, 항목의 의미와 일치하는지 판단
 *
 * 비동기 배치: UrlFetchApp.fetchAll()로 여러 Gemini 호출을 병렬 실행
 */

var GEMINI_MODEL = 'gemini-3-flash';
var RELEVANCE_THRESHOLD = 60; // 문맥 매칭은 더 정밀하므로 임계값 낮춤

// ============================
// 단일 항목 AI 검색
// ============================

function searchByAI(itemContent, folderIds) {
  var apiKey = getGeminiApiKey();
  if (!apiKey) {
    return { files: [], keywords: [], error: 'AI_FALLBACK', message: 'Gemini API 키가 설정되지 않았습니다' };
  }

  // Step 1: 문맥 분석 — 이 항목이 어떤 산출물을 요구하는지 이해
  var context;
  try {
    context = analyzeContext(itemContent, apiKey);
  } catch (e) {
    return { files: [], keywords: [], error: 'AI_FALLBACK', message: '문맥 분석 실패: ' + e.message };
  }

  if (!context || !context.searchQueries || context.searchQueries.length === 0) {
    return { files: [], keywords: [], error: 'AI_FALLBACK', message: 'AI가 검색 전략을 생성하지 못했습니다' };
  }

  // Step 2: 다중 전략 검색 — 문맥 분석 결과로 Drive 검색
  var allFiles = multiStrategySearch(context, folderIds);

  if (allFiles.length === 0) {
    return {
      files: [],
      keywords: context.searchQueries,
      context: context,
      error: null,
      message: '검색 결과 없음 — 산출물 유형: ' + (context.documentType || '알 수 없음')
    };
  }

  // Step 3: 문맥 기반 매칭 — 후보 파일을 AI가 문맥적으로 평가
  var candidates = allFiles.slice(0, 15);
  var scored;
  try {
    scored = evaluateWithContext(itemContent, context, candidates, apiKey);
  } catch (e) {
    // AI 평가 실패 → 파일 내용 기반 커버리지로 fallback
    var searchTerms = extractSearchTerms(itemContent);
    candidates.forEach(function(file) {
      var result = calculateCoverage(file.id, searchTerms);
      file._coverage = result;
    });
    return { files: candidates.slice(0, 5), keywords: context.searchQueries, context: context, error: null, message: '문맥 평가 실패 — 커버리지 기반 결과' };
  }

  // 임계값 이상 필터 + 페이지 감지
  var searchTerms = extractSearchTerms(itemContent);
  var matched = [];
  scored.forEach(function(s) {
    if (s.score >= RELEVANCE_THRESHOLD) {
      var coverageResult = calculateCoverage(s.file.id, searchTerms);
      s.file._coverage = coverageResult;
      s.file._aiScore = s.score;
      s.file._aiReason = s.reason;
      matched.push(s.file);
    }
  });

  return {
    files: matched,
    keywords: context.searchQueries,
    scores: scored,
    context: context,
    searchTerms: searchTerms,
    error: null
  };
}

// ============================
// Step 1: 문맥 분석
// ============================

function analyzeContext(itemContent, apiKey) {
  // 먼저 직접 참조를 추출
  var directRefs = extractDirectReferences(itemContent);

  var prompt =
    '당신은 프로젝트 산출물 문서 전문가입니다.\n\n' +
    '다음은 솔루션 상용화 매뉴얼의 한 항목입니다. ' +
    '이 항목이 요구하는 산출물이 어떤 문서인지 문맥을 분석하세요.\n\n' +
    '항목 내용:\n' + String(itemContent) + '\n\n' +
    '=== 중요 분석 규칙 ===\n\n' +
    '1. **직접 참조 감지**: 내용에 "XXX 별도 존재", "XXX 참조", "XXX 참고", "XXX 문서"처럼\n' +
    '   특정 문서를 직접 언급하는 표현이 있으면, 그 문서명을 최우선 검색 쿼리로 사용하세요.\n' +
    '   예: "운영자 매뉴얼 별도 존재" → 검색 쿼리 1순위: "운영자 매뉴얼"\n\n' +
    '2. **유사어/동의어 확장**: 한국어 산출물명은 조직마다 다르게 부릅니다.\n' +
    '   반드시 다음 변형을 모두 생성하세요:\n' +
    '   - 한자어 변형: 운영자/운용자, 관리자/어드민, 사용자/유저\n' +
    '   - 문서 유형 변형: 매뉴얼/가이드/안내서/지침서/설명서\n' +
    '   - 띄어쓰기 변형: "운용자매뉴얼"/"운용자 매뉴얼"\n' +
    '   - 영문: admin manual, operator guide\n\n' +
    '3. **내용 기반 추론**: 항목 내용이 설명하는 기능/절차를 포함하는 문서를 찾으세요.\n' +
    '   예: "계정/역할/권한 구조" → 관리자 가이드, 운영 매뉴얼에 포함될 가능성 높음\n\n' +
    (directRefs.length > 0
      ? '=== 감지된 직접 참조 ===\n다음 문서가 직접 언급되었습니다: ' + directRefs.join(', ') + '\n이 문서명과 유사어를 검색 쿼리 최상위에 배치하세요.\n\n'
      : '') +
    'JSON으로 응답하세요:\n' +
    '{\n' +
    '  "documentType": "산출물 유형",\n' +
    '  "purpose": "목적과 기대 내용",\n' +
    '  "directReferences": ["내용에서 직접 언급된 문서명 (있을 경우)"],\n' +
    '  "searchQueries": ["쿼리1(직접참조 우선)", "쿼리2(유사어)", "쿼리3", "쿼리4", "쿼리5", "쿼리6", "쿼리7"],\n' +
    '  "fileNamePatterns": ["예상 파일명1", "패턴2", "패턴3"],\n' +
    '  "relatedTerms": ["동의어1", "유사어2", "변형3", "영문4"]\n' +
    '}\n\n' +
    '검색 쿼리는 7개 이상, 다음 우선순위로 생성:\n' +
    '1순위: 직접 참조된 문서명 그대로\n' +
    '2순위: 직접 참조의 유사어/동의어 변형 (운영자→운용자, 매뉴얼→가이드)\n' +
    '3순위: 항목명 기반 검색\n' +
    '4순위: 내용 기반 검색 (기능/절차 키워드)\n' +
    '5순위: 영문 표현';

  var responseText = callGeminiApi(prompt, apiKey);
  var result = parseJsonObject(responseText);

  // 직접 참조가 있으면 searchQueries 최상위에 추가 (중복 방지)
  if (result && directRefs.length > 0) {
    var existing = result.searchQueries || [];
    directRefs.forEach(function(ref) {
      if (existing.indexOf(ref) === -1) {
        existing.unshift(ref);
      }
    });
    result.searchQueries = existing;
    result.directReferences = (result.directReferences || []).concat(directRefs);
  }

  return result;
}

/**
 * 항목 내용에서 다른 문서를 직접 참조하는 표현을 추출한다.
 * 패턴: "XXX 별도 존재", "XXX 참조", "XXX 참고", "XXX에 기술", "XXX 문서"
 */
function extractDirectReferences(content) {
  if (!content) return [];
  var text = String(content);
  var refs = [];

  // "XXX 별도 존재" / "XXX 별도 관리" / "XXX 별도 작성"
  var patterns = [
    /([가-힣A-Za-z0-9_\s]{2,20})\s*(?:별도\s*존재|별도\s*관리|별도\s*작성)/g,
    /([가-힣A-Za-z0-9_\s]{2,20})\s*(?:참조|참고|참조\s*바람)/g,
    /([가-힣A-Za-z0-9_\s]{2,20})\s*(?:에\s*기술|에\s*명시|에\s*정의)/g,
    /([가-힣A-Za-z0-9_\s]{2,20})\s*(?:문서\s*확인|문서\s*참고)/g
  ];

  patterns.forEach(function(pattern) {
    var match;
    while ((match = pattern.exec(text)) !== null) {
      var ref = match[1].trim();
      if (ref.length >= 2 && refs.indexOf(ref) === -1) {
        refs.push(ref);
      }
    }
  });

  return refs;
}

// ============================
// Step 2: 다중 전략 검색
// ============================

function multiStrategySearch(context, folderIds) {
  var allFiles = [];
  var seenIds = {};

  function addFile(file) {
    if (!seenIds[file.id]) {
      seenIds[file.id] = true;
      allFiles.push(file);
    }
  }

  // 전략 0 (최우선): 직접 참조된 문서명으로 파일명 검색
  (context.directReferences || []).forEach(function(ref) {
    var files = searchDriveByName(ref, folderIds);
    files.forEach(addFile);
  });

  // 전략 1: 검색 쿼리로 fullText 검색
  (context.searchQueries || []).forEach(function(query) {
    var files = searchDriveFullText(query, folderIds);
    files.forEach(addFile);
  });

  // 전략 2: 파일명 패턴으로 이름 검색
  (context.fileNamePatterns || []).forEach(function(pattern) {
    var files = searchDriveByName(pattern, folderIds);
    files.forEach(addFile);
  });

  // 전략 3: 유사어로 추가 검색 (아직 후보가 적으면)
  if (allFiles.length < 5) {
    (context.relatedTerms || []).forEach(function(term) {
      var files = searchDriveByName(term, folderIds);
      files.forEach(addFile);
      var files2 = searchDriveFullText(term, folderIds);
      files2.forEach(addFile);
    });
  }

  return allFiles;
}

// ============================
// Step 3: 문맥 기반 매칭 평가
// ============================

function evaluateWithContext(itemContent, context, candidates, apiKey) {
  var fileDescriptions = candidates.map(function(f, i) {
    var desc = (i + 1) + '. 파일명: ' + f.name;
    if (f.mimeType) desc += ' [' + simplifyMimeType(f.mimeType) + ']';
    if (f.description) desc += ' — ' + f.description;
    return desc;
  }).join('\n');

  var prompt =
    '당신은 프로젝트 산출물 매칭 전문가입니다.\n\n' +
    '매뉴얼 항목이 요구하는 산출물과 후보 파일들을 비교하여, ' +
    '각 파일이 이 항목의 산출물로 적합한지 판단하세요.\n\n' +
    '판단 기준 (중요도 순):\n' +
    '1. 문서의 목적이 항목의 요구와 일치하는가?\n' +
    '2. 파일명이 항목이 요구하는 산출물 유형을 나타내는가?\n' +
    '3. 파일 유형(Docs/Sheets/Slides/PDF)이 산출물 형식에 적합한가?\n\n' +
    '=== 중요 판단 규칙 ===\n' +
    '- **유사어는 동일**: 운영자=운용자=관리자, 매뉴얼=가이드=안내서=지침서\n' +
    '- **포함 관계 인정**: "관리자 상세 매뉴얼"의 산출물로 "운용자 매뉴얼"은 적합 (같은 역할의 다른 표현)\n' +
    '- **1-2글자 차이는 동일 문서로 판단**: 운영자/운용자, 사용자/이용자\n' +
    '- 단순 키워드 포함이 아닌, 문맥적 의미를 기준으로 판단하세요.\n' +
    '- "테스트 계획" 항목에 "테스트 결과 보고서"는 관련은 있지만 다른 산출물입니다.\n\n' +
    '=== 매뉴얼 항목 ===\n' +
    String(itemContent) + '\n\n' +
    '=== AI 분석 결과 ===\n' +
    '산출물 유형: ' + (context.documentType || '미분석') + '\n' +
    '목적: ' + (context.purpose || '미분석') + '\n\n' +
    '=== 후보 파일 ===\n' +
    fileDescriptions + '\n\n' +
    'JSON 배열로 응답하세요. 모든 후보에 대해 평가:\n' +
    '[{"index": 1, "score": 0-100, "reason": "매칭/불일치 이유 한 줄"}, ...]\n\n' +
    '점수 기준:\n' +
    '80-100: 이 항목의 산출물이 확실함\n' +
    '60-79: 관련성이 높지만 정확한 산출물인지 추가 확인 필요\n' +
    '40-59: 부분적으로 관련있지만 다른 산출물일 가능성 높음\n' +
    '0-39: 관련 없음';

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

function simplifyMimeType(mimeType) {
  if (mimeType.indexOf('document') !== -1) return 'Docs';
  if (mimeType.indexOf('spreadsheet') !== -1) return 'Sheets';
  if (mimeType.indexOf('presentation') !== -1) return 'Slides';
  if (mimeType.indexOf('pdf') !== -1) return 'PDF';
  if (mimeType.indexOf('word') !== -1) return 'Word';
  if (mimeType.indexOf('excel') !== -1 || mimeType.indexOf('sheet') !== -1) return 'Excel';
  if (mimeType.indexOf('powerpoint') !== -1) return 'PPT';
  return 'File';
}

// ============================
// 캐시된 문맥으로 검색 (배치 분석 결과 활용)
// ============================

function searchByAIWithContext(itemContent, folderIds, cachedContext) {
  var apiKey = getGeminiApiKey();
  if (!apiKey) {
    return { files: [], keywords: [], error: 'AI_FALLBACK', message: 'Gemini API 키 미설정' };
  }

  // 문맥 분석은 캐시 사용 → Drive 검색부터 시작
  var allFiles = multiStrategySearch(cachedContext, folderIds);

  if (allFiles.length === 0) {
    return {
      files: [], keywords: cachedContext.searchQueries || [],
      context: cachedContext, error: null,
      message: '검색 결과 없음 — 산출물 유형: ' + (cachedContext.documentType || '')
    };
  }

  var candidates = allFiles.slice(0, 15);
  var scored;
  try {
    scored = evaluateWithContext(itemContent, cachedContext, candidates, apiKey);
  } catch (e) {
    var searchTerms = extractSearchTerms(itemContent);
    candidates.forEach(function(f) { f._coverage = calculateCoverage(f.id, searchTerms); });
    return { files: candidates.slice(0, 5), keywords: cachedContext.searchQueries || [], context: cachedContext, error: null };
  }

  var searchTerms = extractSearchTerms(itemContent);
  var matched = [];
  scored.forEach(function(s) {
    if (s.score >= RELEVANCE_THRESHOLD) {
      var coverageResult = calculateCoverage(s.file.id, searchTerms);
      s.file._coverage = coverageResult;
      s.file._aiScore = s.score;
      s.file._aiReason = s.reason;
      matched.push(s.file);
    }
  });

  return {
    files: matched, keywords: cachedContext.searchQueries || [],
    scores: scored, context: cachedContext, searchTerms: searchTerms, error: null
  };
}

// ============================
// 시트 전체 분석 → 매칭 계획 수립
// ============================

/**
 * 시트의 전체 항목을 Gemini에 전달하여 매칭 계획을 수립한다.
 * - 프로젝트 도메인/유형 파악
 * - 항목 간 관계 이해 (생명주기, 그룹핑)
 * - 공통 검색 전략 수립
 */
function createMatchingPlan(allItems, apiKey) {
  var itemList = allItems.map(function(item, i) {
    return (i + 1) + '. ' + (item || '(빈 항목)').substring(0, 100);
  }).join('\n');

  // 항목이 너무 많으면 앞 50개 + 뒤 10개만
  if (allItems.length > 60) {
    var front = allItems.slice(0, 50).map(function(item, i) {
      return (i + 1) + '. ' + (item || '').substring(0, 100);
    }).join('\n');
    var back = allItems.slice(-10).map(function(item, i) {
      return (allItems.length - 10 + i + 1) + '. ' + (item || '').substring(0, 100);
    }).join('\n');
    itemList = front + '\n... (중간 ' + (allItems.length - 60) + '개 생략) ...\n' + back;
  }

  var prompt =
    '당신은 프로젝트 산출물 관리 전문가입니다.\n\n' +
    '아래는 솔루션 상용화 매뉴얼의 전체 항목 목록입니다.\n' +
    '이 시트 전체를 분석하여 매칭 계획을 수립하세요.\n\n' +
    '=== 전체 항목 (' + allItems.length + '개) ===\n' +
    itemList + '\n\n' +
    '다음을 분석하여 JSON으로 응답하세요:\n' +
    '{\n' +
    '  "domain": "이 매뉴얼이 속한 도메인 (예: SW개발, SI프로젝트, 솔루션상용화 등)",\n' +
    '  "projectType": "프로젝트 유형 (예: 웹앱, 모바일앱, 시스템통합 등)",\n' +
    '  "lifecycle": "산출물이 따르는 생명주기 (예: 기획→분석→설계→개발→테스트→배포)",\n' +
    '  "groups": [\n' +
    '    {\n' +
    '      "name": "그룹명 (예: 요구사항 관련, 설계 관련, 테스트 관련)",\n' +
    '      "itemIndices": [1, 2, 3],\n' +
    '      "commonSearchTerms": ["공통 검색어1", "검색어2"],\n' +
    '      "expectedDocTypes": ["예상 문서 유형1", "유형2"]\n' +
    '    }\n' +
    '  ],\n' +
    '  "namingConventions": ["이 프로젝트에서 예상되는 파일 명명 규칙"],\n' +
    '  "searchStrategy": "전체 검색 전략 요약 (한 줄)"\n' +
    '}\n\n' +
    '그룹은 관련 항목끼리 묶어주세요. 같은 그룹의 항목들은 비슷한 검색 전략을 공유합니다.';

  var responseText = callGeminiApi(prompt, apiKey);
  return parseJsonObject(responseText);
}

// ============================
// 매칭 계획 기반 배치 문맥 분석
// ============================

/**
 * 매칭 계획을 기반으로 항목별 문맥 분석을 수행한다.
 * 계획의 domain, projectType, groups 정보를 프롬프트에 포함하여
 * 각 항목의 문맥을 더 정확하게 분석한다.
 */
function batchAnalyzeContextWithPlan(items, matchingPlan, apiKey) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    GEMINI_MODEL + ':generateContent?key=' + apiKey;

  var planContext = '';
  if (matchingPlan && matchingPlan.domain) {
    planContext =
      '이 매뉴얼의 도메인: ' + matchingPlan.domain + '\n' +
      '프로젝트 유형: ' + (matchingPlan.projectType || '알 수 없음') + '\n' +
      '생명주기: ' + (matchingPlan.lifecycle || '알 수 없음') + '\n' +
      '명명 규칙: ' + (matchingPlan.namingConventions || []).join(', ') + '\n\n';
  }

  var requests = items.map(function(itemContent) {
    var directRefs = extractDirectReferences(itemContent);
    var refHint = directRefs.length > 0
      ? '\n감지된 직접 참조: ' + directRefs.join(', ') + ' — 이 문서명과 유사어를 검색 쿼리 최상위에 배치.\n'
      : '';

    var prompt =
      '당신은 프로젝트 산출물 문서 전문가입니다.\n\n' +
      planContext +
      '위 프로젝트의 매뉴얼 항목을 분석하세요.\n' +
      '항목: ' + String(itemContent) + '\n' + refHint + '\n' +
      '규칙:\n' +
      '- "XXX 별도 존재/참조/참고" 표현이 있으면 해당 문서명을 최우선 검색 쿼리로\n' +
      '- 유사어 필수 생성: 운영자/운용자/관리자, 매뉴얼/가이드/안내서/지침서, 띄어쓰기 변형\n' +
      '- 검색 쿼리 7개 이상\n\n' +
      'JSON 응답:\n' +
      '{"documentType":"산출물 유형","purpose":"목적",' +
      '"directReferences":["직접 언급된 문서명"],' +
      '"searchQueries":["쿼리1(직접참조)","쿼리2(유사어)","쿼리3","쿼리4","쿼리5","쿼리6","쿼리7"],' +
      '"fileNamePatterns":["패턴1","패턴2","패턴3"],"relatedTerms":["유사어1","유사어2","유사어3","유사어4"]}';

    return {
      url: url,
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024, responseMimeType: 'application/json' }
      }),
      muteHttpExceptions: true
    };
  });

  var responses = UrlFetchApp.fetchAll(requests);

  return responses.map(function(response) {
    try {
      if (response.getResponseCode() !== 200) return null;
      var json = JSON.parse(response.getContentText());
      var text = json.candidates && json.candidates[0] &&
        json.candidates[0].content && json.candidates[0].content.parts &&
        json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
      return text ? parseJsonObject(text) : null;
    } catch (e) {
      return null;
    }
  });
}

// ============================
// 배치 AI 처리 (비동기 병렬)
// ============================

/**
 * 여러 항목의 문맥 분석을 병렬로 실행한다.
 * UrlFetchApp.fetchAll()로 동시에 여러 Gemini API 호출.
 * @param {string[]} items - 항목 내용 배열
 * @returns {Object[]} 문맥 분석 결과 배열
 */
function batchAnalyzeContext(items, apiKey) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    GEMINI_MODEL + ':generateContent?key=' + apiKey;

  var requests = items.map(function(itemContent) {
    var prompt =
      '당신은 프로젝트 산출물 문서 전문가입니다.\n\n' +
      '다음 매뉴얼 항목이 요구하는 산출물을 분석하세요.\n' +
      '항목: ' + String(itemContent) + '\n\n' +
      'JSON 응답:\n' +
      '{"documentType":"산출물 유형","purpose":"목적","searchQueries":["쿼리1","쿼리2","쿼리3","쿼리4","쿼리5"],' +
      '"fileNamePatterns":["패턴1","패턴2"],"relatedTerms":["유사어1","유사어2"]}';

    return {
      url: url,
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024, responseMimeType: 'application/json' }
      }),
      muteHttpExceptions: true
    };
  });

  var responses = UrlFetchApp.fetchAll(requests);

  return responses.map(function(response, i) {
    try {
      if (response.getResponseCode() !== 200) return null;
      var json = JSON.parse(response.getContentText());
      var text = json.candidates && json.candidates[0] &&
        json.candidates[0].content && json.candidates[0].content.parts &&
        json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
      return text ? parseJsonObject(text) : null;
    } catch (e) {
      return null;
    }
  });
}

/**
 * 여러 항목의 관련도 평가를 병렬로 실행한다.
 * @param {Object[]} evaluationRequests - [{itemContent, context, candidates}, ...]
 * @returns {Object[][]} 각 항목별 scored 배열
 */
function batchEvaluateRelevance(evaluationRequests, apiKey) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    GEMINI_MODEL + ':generateContent?key=' + apiKey;

  var requests = evaluationRequests.map(function(req) {
    var fileDescriptions = req.candidates.map(function(f, i) {
      var desc = (i + 1) + '. ' + f.name;
      if (f.mimeType) desc += ' [' + simplifyMimeType(f.mimeType) + ']';
      return desc;
    }).join('\n');

    var prompt =
      '매뉴얼 항목의 산출물로 적합한 파일을 판단하세요.\n' +
      '문맥적 의미 기준으로 판단. 단순 키워드 포함이 아닌 목적 일치 여부.\n\n' +
      '항목: ' + String(req.itemContent) + '\n' +
      '산출물 유형: ' + (req.context.documentType || '') + '\n' +
      '목적: ' + (req.context.purpose || '') + '\n\n' +
      '후보:\n' + fileDescriptions + '\n\n' +
      'JSON: [{"index":1,"score":0-100,"reason":"이유"},...]';

    return {
      url: url,
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024, responseMimeType: 'application/json' }
      }),
      muteHttpExceptions: true
    };
  });

  var responses = UrlFetchApp.fetchAll(requests);

  return responses.map(function(response, i) {
    try {
      if (response.getResponseCode() !== 200) return [];
      var json = JSON.parse(response.getContentText());
      var text = json.candidates && json.candidates[0] &&
        json.candidates[0].content && json.candidates[0].content.parts &&
        json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
      if (!text) return [];
      var scores = parseJsonArray(text);
      var candidates = evaluationRequests[i].candidates;
      return scores.map(function(s) {
        var idx = (s.index || 1) - 1;
        if (idx >= 0 && idx < candidates.length) {
          return { file: candidates[idx], score: s.score || 0, reason: s.reason || '' };
        }
        return null;
      }).filter(function(s) { return s !== null; });
    } catch (e) {
      return [];
    }
  });
}

// ============================
// 공통 유틸리티
// ============================

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

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  if (code === 429) throw new Error('Gemini API 쿼터 초과');
  if (code !== 200) throw new Error('Gemini API 에러 (HTTP ' + code + ')');

  var json = JSON.parse(response.getContentText());
  var text = json.candidates && json.candidates[0] &&
    json.candidates[0].content && json.candidates[0].content.parts &&
    json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
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

function parseJsonObject(text) {
  if (!text) return null;
  try {
    var cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var parsed = JSON.parse(cleaned);
    if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return null;
  } catch (e) {
    var match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { return null; }
    }
    return null;
  }
}
