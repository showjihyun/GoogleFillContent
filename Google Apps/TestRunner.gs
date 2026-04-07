/**
 * TestRunner.gs: 순수 로직 단위 테스트
 * Apps Script 내에서 실행: 메뉴 > FillContent > 테스트 실행 (개발용)
 */

function runAllTests() {
  var results = [];
  results = results.concat(testExtractBaseName());
  results = results.concat(testExtractVersion());
  results = results.concat(testCompareVersions());
  results = results.concat(testGetSuffixPriority());
  results = results.concat(testSelectBestVersion());
  results = results.concat(testExtractFolderIdFromUrl());
  results = results.concat(testExtractKeywordsFromContent());
  results = results.concat(testEscapeQuery());

  var passed = results.filter(function(r) { return r.passed; }).length;
  var failed = results.filter(function(r) { return !r.passed; }).length;

  Logger.log('=== TEST RESULTS ===');
  Logger.log('PASSED: ' + passed + '  FAILED: ' + failed + '  TOTAL: ' + results.length);

  results.forEach(function(r) {
    if (!r.passed) {
      Logger.log('FAIL: ' + r.name + ' — expected: ' + JSON.stringify(r.expected) +
        ', got: ' + JSON.stringify(r.actual));
    }
  });

  if (failed > 0) {
    Logger.log('\n' + failed + ' test(s) FAILED');
  } else {
    Logger.log('\nAll tests passed!');
  }

  return { passed: passed, failed: failed, total: results.length };
}

function assert(name, expected, actual) {
  var passed = JSON.stringify(expected) === JSON.stringify(actual);
  return { name: name, passed: passed, expected: expected, actual: actual };
}

// --- extractBaseName ---

function testExtractBaseName() {
  return [
    assert('baseName: 설계서_v1.0_final.docx',
      '설계서', extractBaseName('설계서_v1.0_final.docx')),
    assert('baseName: 요구사항정의서_v2.1.pdf',
      '요구사항정의서', extractBaseName('요구사항정의서_v2.1.pdf')),
    assert('baseName: API명세서.docx',
      'API명세서', extractBaseName('API명세서.docx')),
    assert('baseName: 테스트결과보고서_V3.0_draft.xlsx',
      '테스트결과보고서', extractBaseName('테스트결과보고서_V3.0_draft.xlsx')),
    assert('baseName: 시스템구성도-최종.pptx',
      '시스템구성도', extractBaseName('시스템구성도-최종.pptx')),
    assert('baseName: release_note_1.2.3.md',
      'release_note', extractBaseName('release_note_1.2.3.md')),
    assert('baseName: 단순파일명',
      '단순파일명', extractBaseName('단순파일명')),
  ];
}

// --- extractVersion ---

function testExtractVersion() {
  return [
    assert('version: v1.0', { major: 1, minor: 0, patch: 0 }, extractVersion('문서_v1.0.docx')),
    assert('version: V2.1', { major: 2, minor: 1, patch: 0 }, extractVersion('문서_V2.1.pdf')),
    assert('version: v1.0.3', { major: 1, minor: 0, patch: 3 }, extractVersion('문서_v1.0.3.docx')),
    assert('version: 3.2', { major: 3, minor: 2, patch: 0 }, extractVersion('문서_3.2.xlsx')),
    assert('version: none', null, extractVersion('문서.docx')),
    assert('version: none2', null, extractVersion('회의록_20240301')),
  ];
}

// --- compareVersions ---

function testCompareVersions() {
  return [
    assert('compare: 1.0 < 2.0', true,
      compareVersions({ major: 1, minor: 0, patch: 0 }, { major: 2, minor: 0, patch: 0 }) < 0),
    assert('compare: 1.1 > 1.0', true,
      compareVersions({ major: 1, minor: 1, patch: 0 }, { major: 1, minor: 0, patch: 0 }) > 0),
    assert('compare: 1.0.1 > 1.0.0', true,
      compareVersions({ major: 1, minor: 0, patch: 1 }, { major: 1, minor: 0, patch: 0 }) > 0),
    assert('compare: 1.0 == 1.0', true,
      compareVersions({ major: 1, minor: 0, patch: 0 }, { major: 1, minor: 0, patch: 0 }) === 0),
  ];
}

// --- getSuffixPriority ---

function testGetSuffixPriority() {
  return [
    assert('suffix: draft = -1', -1, getSuffixPriority('문서_v1.0-draft.docx')),
    assert('suffix: final = 1', 1, getSuffixPriority('문서_v1.0-final.docx')),
    assert('suffix: approved = 1', 1, getSuffixPriority('문서_v1.0-approved.docx')),
    assert('suffix: 최종 = 1', 1, getSuffixPriority('문서_v1.0-최종.docx')),
    assert('suffix: 임시 = -1', -1, getSuffixPriority('문서_v1.0-임시.docx')),
    assert('suffix: none = 0', 0, getSuffixPriority('문서_v1.0.docx')),
    assert('suffix: backup = -1', -1, getSuffixPriority('문서_backup.docx')),
  ];
}

// --- selectBestVersion ---

function testSelectBestVersion() {
  var files = [
    { name: '설계서_v1.0.docx', id: '1', modifiedTime: '2024-01-01' },
    { name: '설계서_v2.0.docx', id: '2', modifiedTime: '2024-02-01' },
    { name: '설계서_v2.0-draft.docx', id: '3', modifiedTime: '2024-03-01' },
  ];

  var result = selectBestVersion(files);
  var results = [
    assert('bestVersion: v2.0 > v1.0 (not draft)', '2', result.id),
  ];

  var filesNover = [
    { name: '회의록_A.docx', id: 'a', modifiedTime: '2024-01-01' },
    { name: '회의록_B.docx', id: 'b', modifiedTime: '2024-06-01' },
  ];
  var resultNover = selectBestVersion(filesNover);
  results.push(assert('bestVersion: no version → latest date', 'b', resultNover.id));

  var filesFinal = [
    { name: '보고서_v1.0.docx', id: 'x', modifiedTime: '2024-01-01' },
    { name: '보고서_v1.0-final.docx', id: 'y', modifiedTime: '2024-01-02' },
  ];
  var resultFinal = selectBestVersion(filesFinal);
  results.push(assert('bestVersion: same version, final wins', 'y', resultFinal.id));

  return results;
}

// --- extractFolderIdFromUrl ---

function testExtractFolderIdFromUrl() {
  return [
    assert('folderUrl: standard',
      '1ABC_def-123',
      extractFolderIdFromUrl('https://drive.google.com/drive/folders/1ABC_def-123')),
    assert('folderUrl: with query params',
      '1ABC_def-123',
      extractFolderIdFromUrl('https://drive.google.com/drive/folders/1ABC_def-123?resourcekey=abc')),
    assert('folderUrl: with u/0',
      '1ABC_def-123',
      extractFolderIdFromUrl('https://drive.google.com/drive/u/0/folders/1ABC_def-123')),
    assert('folderUrl: raw ID',
      '1ABC_def-123XYZ',
      extractFolderIdFromUrl('1ABC_def-123XYZ')),
    assert('folderUrl: invalid',
      null,
      extractFolderIdFromUrl('https://google.com')),
    assert('folderUrl: empty',
      null,
      extractFolderIdFromUrl('')),
  ];
}

// --- extractKeywordsFromContent ---

function testExtractKeywordsFromContent() {
  var kw1 = extractKeywordsFromContent('소프트웨어 요구사항 정의서 작성');
  var results = [
    assert('keywords: length > 0', true, kw1.length > 0),
    assert('keywords: contains 소프트웨어', true, kw1.indexOf('소프트웨어') !== -1),
    assert('keywords: max 5', true, kw1.length <= 5),
  ];

  var kw2 = extractKeywordsFromContent('');
  results.push(assert('keywords: empty input', 0, kw2.length));

  var kw3 = extractKeywordsFromContent('의 를 이 가 을');
  results.push(assert('keywords: all stopwords', 0, kw3.length));

  return results;
}

// --- escapeQuery ---

function testEscapeQuery() {
  return [
    assert('escape: apostrophe', "it\\'s", escapeQuery("it's")),
    assert('escape: backslash', 'path\\\\file', escapeQuery('path\\file')),
    assert('escape: normal', 'hello', escapeQuery('hello')),
  ];
}
