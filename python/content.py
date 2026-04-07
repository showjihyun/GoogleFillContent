"""
content.py: 파일 내용 추출 + 페이지 분할 + 빠른 매칭 체크
"""

import logging
import re
from google_api import export_file_as_text

CHARS_PER_PAGE = 2500
PAGE_SUMMARY_LENGTH = 1000  # 페이지당 요약 길이 (300→1000으로 확대)
MAX_PAGES_PER_FILE = 50

# 불용어
STOP_WORDS = {
    "및", "또는", "위한", "대한", "관련", "포함", "기반", "통한", "따른",
    "있는", "없는", "하는", "되는", "된다", "에서", "으로", "에게", "까지",
    "부터", "의", "을", "를", "이", "가", "은", "는", "와", "과", "도", "만",
    "the", "and", "or", "for", "of", "in", "to", "a", "an", "is", "are",
    "be", "with", "that", "this",
}


def extract_search_terms(content: str) -> list[str]:
    """검색 내용에서 핵심 용어를 추출한다."""
    if not content:
        return []
    words = re.split(r"[\s,;·/\(\)\[\]\{\}「」『』<>]+", content)
    words = [re.sub(r"^[.\-_]+|[.\-_]+$", "", w).strip() for w in words]
    words = [w for w in words if len(w) >= 2 and w.lower() not in STOP_WORDS]

    seen = set()
    unique = []
    for w in words:
        key = w.lower()
        if key not in seen:
            seen.add(key)
            unique.append(w)
    return unique


def index_file(
    file: dict, search_items: list[str], drive_service,
    log: logging.Logger = None
) -> dict:
    """파일의 내용을 페이지 단위로 인덱싱한다."""
    if not log:
        log = logging.getLogger("fillcontent")

    result = {
        "file_id": file["id"],
        "file_name": file["name"],
        "folder_path": file.get("_folder_path", ""),
        "pages": [],
        "fully_indexed": False,
    }

    mime_type = file.get("mimeType", "")
    log.debug(f"  인덱싱 시작: {file['name']} [{mime_type}]")

    text = export_file_as_text(drive_service, file["id"], mime_type)
    if not text:
        log.debug(f"  인덱싱 실패: {file['name']} — 내용 추출 불가")
        return result

    log.debug(f"  내용 추출 완료: {file['name']} ({len(text)}자)")
    pages = _split_into_pages(text, mime_type)
    log.debug(f"  페이지 분할: {len(pages)}페이지")

    for i, page in enumerate(pages[:MAX_PAGES_PER_FILE]):
        summary = page["text"][:PAGE_SUMMARY_LENGTH]
        matched_items = _quick_match_page(page["text"], search_items)

        result["pages"].append({
            "page_num": page["page_num"],
            "page_label": page["page_label"],
            "summary": summary,
            "matched_item_indices": matched_items,
            "has_match": len(matched_items) > 0,
        })

        if matched_items:
            log.debug(f"    {page['page_label']}: {len(matched_items)}개 항목 매칭 후보")

        # 3페이지 이상 읽고 매칭 발견되면 Continue
        if i >= 2 and matched_items:
            total_matched = set()
            for pg in result["pages"]:
                total_matched.update(pg["matched_item_indices"])
            if total_matched:
                result["fully_indexed"] = True
                log.debug(f"  조기 종료: {file['name']} — {len(total_matched)}개 항목 매칭 확인")
                return result

    result["fully_indexed"] = True
    return result


def _split_into_pages(text: str, mime_type: str) -> list[dict]:
    """텍스트를 페이지 단위로 분할한다."""
    pages = []
    page_num = 1

    if "presentation" in mime_type:
        slides = re.split(r"\n---+\n|\n\f", text)
        for s in slides:
            s = s.strip()
            if s:
                pages.append({
                    "page_num": page_num,
                    "page_label": f"슬라이드 {page_num}",
                    "text": s,
                })
                page_num += 1
        if pages:
            return pages

    for i in range(0, len(text), CHARS_PER_PAGE):
        page_text = text[i:i + CHARS_PER_PAGE]
        pages.append({
            "page_num": page_num,
            "page_label": f"p.{page_num}",
            "text": page_text,
        })
        page_num += 1

    return pages


def _quick_match_page(page_text: str, search_items: list[str]) -> list[int]:
    """페이지와 검색 항목들을 빠르게 대조한다 (30% 임계값)."""
    page_lower = page_text.lower()
    matched = []

    for idx, item in enumerate(search_items):
        if not item:
            continue
        terms = extract_search_terms(item)
        if not terms:
            continue

        hit_count = sum(1 for t in terms if t.lower() in page_lower)
        if hit_count / len(terms) >= 0.3:
            matched.append(idx)

    return matched


def format_file_index(file_indexes: list[dict]) -> str:
    """파일 인덱스를 AI 프롬프트용 텍스트로 변환한다."""
    parts = []
    for i, fi in enumerate(file_indexes):
        folder_path = fi.get("folder_path", "")
        path_info = f" 📁{folder_path}" if folder_path else ""
        header = f"[파일 {i + 1}] {fi['file_name']}{path_info}"
        if not fi["pages"]:
            parts.append(f"{header}\n  (내용 추출 불가)")
            continue

        page_lines = []
        for pg in fi["pages"]:
            line = f"  {pg['page_label']}: {pg['summary']}"
            if len(pg["summary"]) >= PAGE_SUMMARY_LENGTH:
                line += "..."
            page_lines.append(line)

        parts.append(f"{header}\n" + "\n".join(page_lines))

    text = "\n\n".join(parts)

    if len(text) > 200000:
        parts = []
        for i, fi in enumerate(file_indexes):
            folder_path = fi.get("folder_path", "")
            path_info = f" 📁{folder_path}" if folder_path else ""
            header = f"[파일 {i + 1}] {fi['file_name']}{path_info}"
            if not fi["pages"]:
                parts.append(f"{header} (내용 없음)")
                continue
            first_pages = fi["pages"][:3]
            page_lines = [
                f"  {pg['page_label']}: {pg['summary'][:150]}..."
                for pg in first_pages
            ]
            parts.append(f"{header} ({len(fi['pages'])}페이지)\n" + "\n".join(page_lines))
        text = "\n\n".join(parts)

    return text
