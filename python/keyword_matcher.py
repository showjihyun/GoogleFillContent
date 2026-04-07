"""
keyword_matcher.py: 문자열 기반 키워드 매칭 (LLM 미사용)

검색 기준 항목의 핵심 용어를 추출하고,
파일 인덱스의 페이지 내용과 대조하여 커버리지 80% 이상인 파일을 매칭한다.
"""

import logging
from content import extract_search_terms
from version import resolve_version

COVERAGE_THRESHOLD = 0.8  # 80%


def match_by_keyword(
    search_items: list[str],
    file_indexes: list[dict],
    log: logging.Logger = None,
) -> list[dict]:
    """키워드(문자열) 매칭으로 항목별 최적 파일을 찾는다."""
    if not log:
        log = logging.getLogger("fillcontent")

    matches = []

    for item_idx, item in enumerate(search_items):
        if not item.strip():
            matches.append(_empty_match(item_idx))
            continue

        terms = extract_search_terms(item)
        if not terms:
            log.debug(f"  [{item_idx}] 키워드 추출 실패: {item[:50]}")
            matches.append(_empty_match(item_idx, reason="키워드 추출 불가"))
            continue

        log.debug(f"  [{item_idx}] 키워드: {terms}")

        # 모든 파일에 대해 커버리지 계산
        candidates = []
        for fi in file_indexes:
            if not fi["pages"]:
                continue

            coverage = _calculate_coverage(fi, terms)
            if coverage["ratio"] >= COVERAGE_THRESHOLD:
                candidates.append({
                    "file_index": fi,
                    "coverage": coverage,
                })

        if not candidates:
            log.debug(f"  [{item_idx}] 매칭 실패 — 커버리지 {COVERAGE_THRESHOLD*100}% 이상 파일 없음")
            matches.append(_empty_match(item_idx, reason="관련 파일 없음"))
            continue

        # 커버리지 높은 순 정렬
        candidates.sort(key=lambda c: c["coverage"]["ratio"], reverse=True)

        # 버전 해석 (같은 문서의 여러 버전이면 최신 선택)
        candidate_files = [
            {"id": c["file_index"]["file_id"], "name": c["file_index"]["file_name"],
             "modifiedTime": "", "_coverage": c["coverage"]}
            for c in candidates
        ]
        resolved = resolve_version(candidate_files)
        best = resolved[0] if resolved else candidate_files[0]
        best_coverage = best.get("_coverage", candidates[0]["coverage"])

        score = int(best_coverage["ratio"] * 100)
        page_str = _format_pages(best_coverage.get("matched_pages", []))

        log.debug(
            f"  [{item_idx}] 매칭: {best['name']} "
            f"(커버리지: {score}%, 매칭 용어: {best_coverage['matched']}/{best_coverage['total']})"
        )

        matches.append({
            "item_index": item_idx,
            "file_id": best["id"],
            "file_name": best["name"],
            "page": page_str,
            "score": score,
            "reason": f"키워드 커버리지 {score}% ({best_coverage['matched']}/{best_coverage['total']})",
        })

    return matches


def _calculate_coverage(file_index: dict, terms: list[str]) -> dict:
    """파일 인덱스의 전체 페이지에서 검색 용어의 커버리지를 계산한다."""
    all_text = " ".join(pg["summary"] for pg in file_index["pages"]).lower()

    matched_terms = []
    unmatched_terms = []
    matched_pages = []

    for term in terms:
        if term.lower() in all_text:
            matched_terms.append(term)
        else:
            unmatched_terms.append(term)

    # 매칭된 용어가 어떤 페이지에 있는지 확인
    for pg in file_index["pages"]:
        pg_lower = pg["summary"].lower()
        for term in matched_terms:
            if term.lower() in pg_lower:
                if pg["page_label"] not in matched_pages:
                    matched_pages.append(pg["page_label"])
                break

    ratio = len(matched_terms) / len(terms) if terms else 0

    return {
        "ratio": ratio,
        "matched": len(matched_terms),
        "total": len(terms),
        "matched_terms": matched_terms,
        "unmatched_terms": unmatched_terms,
        "matched_pages": matched_pages,
    }


def _format_pages(pages: list[str]) -> str:
    """페이지 리스트를 문자열로 포맷한다."""
    if not pages:
        return ""
    return ", ".join(pages[:5])


def _empty_match(item_idx: int, reason: str = "관련 파일 없음") -> dict:
    return {
        "item_index": item_idx,
        "file_id": None,
        "file_name": None,
        "page": None,
        "score": 0,
        "reason": reason,
    }
