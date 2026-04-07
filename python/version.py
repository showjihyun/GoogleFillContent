"""
version.py: 파일 버전 판별 + 최적 버전 선택
"""

import re
from datetime import datetime

VERSION_REGEX = re.compile(r"[vV]?\s*(\d+)[._](\d+)(?:[._](\d+))?")
SUFFIX_LOW = ["-draft", "-temp", "-backup", "_draft", "_temp", "_backup", "-임시", "_임시"]
SUFFIX_HIGH = [
    "-final", "-approved", "-릴리즈", "_final", "_approved",
    "_릴리즈", "-최종", "_최종", "-완료", "_완료",
]


def extract_base_name(file_name: str) -> str:
    """파일명에서 버전/접미사를 제거한 기본명을 추출한다."""
    name = file_name
    # 확장자 제거 (알려진 확장자 패턴만)
    ext_match = re.search(r"\.(docx?|xlsx?|pptx?|pdf|txt|csv|hwp|hwpx|md)$", name, re.IGNORECASE)
    if ext_match:
        name = name[:ext_match.start()]

    name = re.sub(r"[_\s]*[vV]?\s*\d+[._]\d+(?:[._]\d+)?", "", name)

    for suffix in SUFFIX_LOW + SUFFIX_HIGH:
        lower = name.lower()
        idx = lower.rfind(suffix)
        if idx > 0 and idx == len(name) - len(suffix):
            name = name[:idx]

    name = re.sub(r"[_\-\s]+$", "", name).strip()
    return name


def extract_version(file_name: str) -> tuple[int, int, int] | None:
    m = VERSION_REGEX.search(file_name)
    if not m:
        return None
    return (
        int(m.group(1)),
        int(m.group(2)),
        int(m.group(3)) if m.group(3) else 0,
    )


def get_suffix_priority(file_name: str) -> int:
    lower = file_name.lower()
    for s in SUFFIX_HIGH:
        if s in lower:
            return 1
    for s in SUFFIX_LOW:
        if s in lower:
            return -1
    return 0


def resolve_version(files: list[dict]) -> list[dict]:
    """파일 그룹에서 각 기본명별 최신 버전만 선택한다."""
    if not files:
        return []
    if len(files) == 1:
        return files

    groups: dict[str, list[dict]] = {}
    for f in files:
        base = extract_base_name(f["name"])
        groups.setdefault(base, []).append(f)

    best_files = []
    for group in groups.values():
        best = _select_best(group)
        if best:
            best_files.append(best)

    return best_files or files[:1]


def _select_best(files: list[dict]) -> dict | None:
    if not files:
        return None
    if len(files) == 1:
        return files[0]

    with_ver = []
    without_ver = []
    for f in files:
        ver = extract_version(f["name"])
        if ver:
            with_ver.append((f, ver))
        else:
            without_ver.append(f)

    if with_ver:
        with_ver.sort(key=lambda x: (x[1], get_suffix_priority(x[0]["name"])), reverse=True)
        return with_ver[0][0]

    without_ver.sort(
        key=lambda f: f.get("modifiedTime", ""),
        reverse=True,
    )
    return without_ver[0]
