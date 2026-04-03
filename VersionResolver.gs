/**
 * VersionResolver.gs: 파일 버전 판별, 기본명 추출, 버전 비교
 */

var VERSION_REGEX = /[vV]?\s*(\d+)[\._](\d+)(?:[\._](\d+))?/;
var SUFFIX_LOW = ['-draft', '-temp', '-backup', '_draft', '_temp', '_backup', '-임시', '_임시'];
var SUFFIX_HIGH = ['-final', '-approved', '-릴리즈', '_final', '_approved', '_릴리즈', '-최종', '_최종', '-완료', '_완료'];

function extractBaseName(fileName) {
  var name = fileName;
  // 확장자 제거
  var dotIndex = name.lastIndexOf('.');
  if (dotIndex > 0) {
    name = name.substring(0, dotIndex);
  }
  // 버전 패턴 제거
  name = name.replace(/[_\s]*[vV]?\s*\d+[\._]\d+(?:[\._]\d+)?/g, '');
  // 접미사 제거
  var allSuffixes = SUFFIX_LOW.concat(SUFFIX_HIGH);
  allSuffixes.forEach(function(suffix) {
    var idx = name.toLowerCase().lastIndexOf(suffix);
    if (idx > 0 && idx === name.length - suffix.length) {
      name = name.substring(0, idx);
    }
  });
  // 끝 언더스코어/하이픈 정리
  name = name.replace(/[_\-\s]+$/, '').trim();
  return name;
}

function extractVersion(fileName) {
  var match = fileName.match(VERSION_REGEX);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: match[3] ? parseInt(match[3], 10) : 0
  };
}

function getSuffixPriority(fileName) {
  var lower = fileName.toLowerCase();
  for (var i = 0; i < SUFFIX_HIGH.length; i++) {
    if (lower.indexOf(SUFFIX_HIGH[i]) !== -1) return 1;
  }
  for (var j = 0; j < SUFFIX_LOW.length; j++) {
    if (lower.indexOf(SUFFIX_LOW[j]) !== -1) return -1;
  }
  return 0;
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function resolveVersion(files) {
  if (!files || files.length === 0) return null;
  if (files.length === 1) return files[0];

  // 기본명으로 그룹핑
  var groups = {};
  files.forEach(function(file) {
    var base = extractBaseName(file.name);
    if (!groups[base]) groups[base] = [];
    groups[base].push(file);
  });

  // 각 그룹에서 최고 버전 선택
  var bestFiles = [];
  Object.keys(groups).forEach(function(base) {
    var group = groups[base];
    var best = selectBestVersion(group);
    if (best) bestFiles.push(best);
  });

  if (bestFiles.length === 0) return files[0];
  if (bestFiles.length === 1) return bestFiles[0];
  return bestFiles;
}

function selectBestVersion(files) {
  if (files.length === 0) return null;
  if (files.length === 1) return files[0];

  // 버전 번호가 있는 파일과 없는 파일 분리
  var withVersion = [];
  var withoutVersion = [];
  files.forEach(function(file) {
    var ver = extractVersion(file.name);
    if (ver) {
      withVersion.push({ file: file, version: ver });
    } else {
      withoutVersion.push(file);
    }
  });

  if (withVersion.length > 0) {
    // 버전 번호 최고 → 같은 버전이면 접미사 우선순위
    withVersion.sort(function(a, b) {
      var vComp = compareVersions(a.version, b.version);
      if (vComp !== 0) return -vComp; // 내림차순
      var sPri = getSuffixPriority(b.file.name) - getSuffixPriority(a.file.name);
      return sPri;
    });
    return withVersion[0].file;
  }

  // 버전 번호 없으면 수정일 최신
  withoutVersion.sort(function(a, b) {
    var dateA = new Date(a.modifiedTime || 0);
    var dateB = new Date(b.modifiedTime || 0);
    return dateB.getTime() - dateA.getTime();
  });
  return withoutVersion[0];
}
