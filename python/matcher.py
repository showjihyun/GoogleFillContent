"""
matcher.py: OpenAI 기반 매칭 (프롬프트 강화 + 2차 검증)
"""

import json
import logging
import os
from openai import OpenAI
from content import format_file_index

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.4")
CHUNK_SIZE = 20  # 한번에 매칭할 항목 수
VERIFY_THRESHOLD = 65  # 이 점수 미만이면 2차 검증 (70+는 유지)


def create_client() -> OpenAI:
    return OpenAI()


def create_matching_plan(
    search_items: list[str], client: OpenAI, log: logging.Logger = None
) -> dict | None:
    """시트 전체 항목을 분석하여 매칭 계획을 수립한다."""
    if not log:
        log = logging.getLogger("fillcontent")

    log.debug(f"  매칭 계획 수립 요청: {len(search_items)}개 항목")
    item_list = _build_item_list(search_items)

    prompt = (
        "당신은 프로젝트 산출물 관리 전문가입니다.\n\n"
        "아래는 솔루션 상용화 매뉴얼의 전체 항목 목록입니다.\n"
        "이 시트 전체를 분석하여 매칭 계획을 수립하세요.\n\n"
        f"=== 전체 항목 ({len(search_items)}개) ===\n"
        f"{item_list}\n\n"
        "다음을 분석하여 JSON으로 응답하세요:\n"
        "{\n"
        '  "domain": "이 매뉴얼이 속한 도메인",\n'
        '  "projectType": "프로젝트 유형",\n'
        '  "lifecycle": "산출물 생명주기",\n'
        '  "namingConventions": ["예상 파일 명명 규칙"],\n'
        '  "searchStrategy": "전체 검색 전략 요약"\n'
        "}"
    )

    log.debug(f"  프롬프트 길이: {len(prompt)}자")
    result = _call_openai_json(prompt, client, log)
    if result:
        log.debug(f"  매칭 계획 수립 완료: {json.dumps(result, ensure_ascii=False)[:200]}")
    else:
        log.warning("  매칭 계획 수립 실패")
    return result


def match_all(
    search_items: list[str],
    file_indexes: list[dict],
    matching_plan: dict | None,
    client: OpenAI,
    log: logging.Logger = None,
    on_matches=None,
) -> list[dict]:
    """항목과 파일을 매칭한다. 항목이 많으면 청크로 나눠서 처리.

    Args:
        on_matches: 콜백 함수. 청크 매칭이 끝날 때마다 호출되어 즉시 시트에 기입.
                    signature: on_matches(matches: list[dict])
    """
    if not log:
        log = logging.getLogger("fillcontent")

    # 1차 매칭
    if len(file_indexes) <= 20 and len(search_items) <= 30:
        log.debug(f"  단일 배치 매칭: {len(search_items)}개 항목 x {len(file_indexes)}개 파일")
        matches = _match_chunk(search_items, file_indexes, matching_plan, client, log, offset=0)
        if on_matches:
            on_matches(matches)
    else:
        total_chunks = (len(search_items) + CHUNK_SIZE - 1) // CHUNK_SIZE
        log.info(f"  청크 분할 매칭: {len(search_items)}개 항목 → {total_chunks}개 청크")

        matches = []
        for i in range(0, len(search_items), CHUNK_SIZE):
            chunk_num = i // CHUNK_SIZE + 1
            chunk = search_items[i:i + CHUNK_SIZE]
            log.info(f"  청크 {chunk_num}/{total_chunks} 처리 중 ({len(chunk)}개 항목)...")
            chunk_matches = _match_chunk(chunk, file_indexes, matching_plan, client, log, offset=i)
            matches.extend(chunk_matches)
            log.debug(f"  청크 {chunk_num} 완료: {len(chunk_matches)}개 결과")
            # 청크 매칭 즉시 시트 기입
            if on_matches:
                on_matches(chunk_matches)

    # 2차 검증: 저점수 항목 재매칭
    low_score = [m for m in matches if m.get("file_id") and m.get("score", 0) < VERIFY_THRESHOLD]
    if low_score:
        log.info(f"  2차 검증: {len(low_score)}개 저점수 항목 재확인")
        matches = _verify_low_scores(
            matches, low_score, search_items, file_indexes, matching_plan, client, log,
            on_matches=on_matches,
        )

    return matches


def _match_chunk(
    items: list[str],
    file_indexes: list[dict],
    matching_plan: dict | None,
    client: OpenAI,
    log: logging.Logger,
    offset: int = 0,
) -> list[dict]:
    """항목 청크와 전체 파일 인덱스를 매칭한다."""
    item_list = "\n".join(
        f"[항목 {i + 1}] {(item or '(빈 항목)')[:200]}"
        for i, item in enumerate(items)
    )
    file_index_text = format_file_index(file_indexes)

    plan_context = ""
    if matching_plan and matching_plan.get("domain"):
        plan_context = (
            f"프로젝트 도메인: {matching_plan['domain']}\n"
            f"프로젝트 유형: {matching_plan.get('projectType', '')}\n"
            f"생명주기: {matching_plan.get('lifecycle', '')}\n\n"
        )

    prompt = (
        "당신은 프로젝트 산출물 매칭 전문가입니다.\n\n"
        f"{plan_context}"
        "아래 매뉴얼 항목 목록과 파일 목록(내용+폴더경로 포함)을 보고,\n"
        "각 항목에 가장 적합한 파일과 페이지를 매칭하세요.\n\n"
        "=== 매칭 규칙 ===\n"
        "1. 파일명뿐 아니라 **파일 내용(페이지별 요약)**과 **폴더 경로**를 종합 판단하세요.\n"
        "2. 유사어는 동일: 운영자=운용자=관리자, 매뉴얼=가이드=안내서=지침서=설명서\n"
        "3. 항목이 직접 언급하는 문서가 있으면 해당 파일 우선.\n"
        "4. 매칭할 파일이 없으면 fileIndex를 null로. **무리하게 매칭하지 마세요.**\n"
        "5. 한 파일이 여러 항목에 매칭될 수 있음.\n"
        "6. 페이지 번호는 관련 내용이 있는 페이지를 명시.\n"
        "7. **항목의 핵심 요구사항과 파일 내용이 70% 이상 일치**해야 매칭으로 판단.\n"
        "8. 부분적으로 관련 있더라도, 해당 항목의 **주된 산출물**이 아니면 점수를 낮추세요.\n"
        "9. 항목 내용이 비어있거나 '완료' 같은 상태값만 있으면 score=0으로.\n\n"
        f"=== 매뉴얼 항목 ({len(items)}개) ===\n"
        f"{item_list}\n\n"
        f"=== 파일 목록 + 내용 ({len(file_indexes)}개) ===\n"
        f"{file_index_text}\n\n"
        "JSON으로 응답하세요. 반드시 모든 항목에 대해 응답:\n"
        '{"matches": [\n'
        '  {"itemIndex": 1, "fileIndex": 3, "page": "p.5", "score": 85, "reason": "매칭 이유"},\n'
        '  {"itemIndex": 2, "fileIndex": null, "page": null, "score": 0, "reason": "관련 파일 없음"},\n'
        "  ...\n"
        "]}\n\n"
        "score 기준:\n"
        "90-100: 파일명+내용이 항목 요구사항과 정확히 일치\n"
        "80-89: 핵심 내용이 포함되어 있어 해당 산출물로 확실함\n"
        "70-79: 관련 내용이 있지만 일부만 포함되거나 간접적\n"
        "60-69: 약한 관련성 — 더 적합한 파일이 없을 때만\n"
        "0-59: 매칭 아님 (fileIndex를 null로)"
    )

    log.debug(f"  매칭 프롬프트 길이: {len(prompt)}자")
    result = _call_openai_json(prompt, client, log)
    if not result:
        log.warning("  매칭 API 응답 없음")
        return []

    matches_raw = result.get("matches", [])
    if isinstance(result, list):
        matches_raw = result

    log.debug(f"  API 응답: {len(matches_raw)}개 매칭 결과")

    matches = []
    for m in matches_raw:
        file_idx = m.get("fileIndex")
        fi = None
        if file_idx is not None and 1 <= file_idx <= len(file_indexes):
            fi = file_indexes[file_idx - 1]

        matches.append({
            "item_index": (m.get("itemIndex", 1) - 1) + offset,
            "file_id": fi["file_id"] if fi else None,
            "file_name": fi["file_name"] if fi else None,
            "page": m.get("page"),
            "score": m.get("score", 0),
            "reason": m.get("reason", ""),
        })

    return matches


def _verify_low_scores(
    all_matches: list[dict],
    low_score_matches: list[dict],
    search_items: list[str],
    file_indexes: list[dict],
    matching_plan: dict | None,
    client: OpenAI,
    log: logging.Logger,
    on_matches=None,
) -> list[dict]:
    """저점수 항목을 개별적으로 재검증한다.

    1차 매칭에서 할당된 파일의 전체 내용 + 상위 5개 대안 후보를 함께 보여주고
    더 적합한 파일이 있는지, 또는 현재 매칭이 맞는지 재확인한다.
    """
    # 파일 인덱스를 ID로 빠르게 조회
    fi_by_id = {fi["file_id"]: fi for fi in file_indexes}

    for low_match in low_score_matches:
        item_idx = low_match["item_index"]
        item_content = search_items[item_idx] if item_idx < len(search_items) else ""
        if not item_content.strip():
            continue

        current_file_id = low_match.get("file_id")
        current_fi = fi_by_id.get(current_file_id) if current_file_id else None

        # 현재 매칭 파일의 전체 내용 (요약이 아닌 전문)
        current_detail = ""
        if current_fi and current_fi["pages"]:
            current_detail = "\n".join(
                f"  {pg['page_label']}: {pg['summary']}"
                for pg in current_fi["pages"]
            )

        # 대안 후보: 페이지 매칭 기반으로 관련 파일 5개 추가 선정
        candidates = []
        for fi in file_indexes:
            if fi["file_id"] == current_file_id:
                continue
            for pg in fi["pages"]:
                if item_idx in pg.get("matched_item_indices", []):
                    candidates.append(fi)
                    break
        candidates = candidates[:5]

        candidates_text = ""
        if candidates:
            parts = []
            for j, fi in enumerate(candidates):
                folder_path = fi.get("folder_path", "")
                path_info = f" 📁{folder_path}" if folder_path else ""
                header = f"[대안 {j + 1}] {fi['file_name']}{path_info}"
                page_lines = [
                    f"    {pg['page_label']}: {pg['summary']}"
                    for pg in fi["pages"][:5]
                ]
                parts.append(f"  {header}\n" + "\n".join(page_lines))
            candidates_text = "\n".join(parts)

        plan_context = ""
        if matching_plan and matching_plan.get("domain"):
            plan_context = f"프로젝트 도메인: {matching_plan['domain']}\n"

        prompt = (
            "당신은 프로젝트 산출물 매칭 검증 전문가입니다.\n\n"
            f"{plan_context}"
            "아래 매뉴얼 항목에 대해 1차 매칭된 파일이 정확한지 검증하세요.\n"
            "더 적합한 대안 파일이 있으면 대안으로 교체하세요.\n\n"
            f"=== 매뉴얼 항목 ===\n{item_content}\n\n"
            f"=== 1차 매칭 파일 ===\n"
            f"파일명: {low_match.get('file_name', '?')}\n"
            f"1차 점수: {low_match.get('score', '?')}\n"
            f"1차 사유: {low_match.get('reason', '?')}\n"
            f"내용 전문:\n{current_detail}\n\n"
        )

        if candidates_text:
            prompt += f"=== 대안 후보 파일 ===\n{candidates_text}\n\n"

        prompt += (
            "검증 결과를 JSON으로 응답:\n"
            "{\n"
            '  "decision": "keep" 또는 "replace" 또는 "none",\n'
            '  "fileIndex": 대안 번호(replace 시) 또는 null,\n'
            '  "score": 재평가 점수(0-100),\n'
            '  "reason": "검증 사유"\n'
            "}\n\n"
            "- keep: 현재 매칭을 유지 (점수 재조정 가능). **부분적으로라도 관련 있으면 keep 우선.**\n"
            "- replace: 대안 파일이 **명백히** 더 적합할 때만\n"
            "- none: 현재 파일과 항목이 **전혀** 관련 없을 때만. 부분 매칭은 keep으로 유지하세요."
        )

        log.debug(f"  2차 검증 [{item_idx}]: {item_content[:40]}")
        result = _call_openai_json(prompt, client, log)

        if not result:
            continue

        decision = result.get("decision", "keep")
        new_score = result.get("score", low_match.get("score", 0))
        new_reason = result.get("reason", low_match.get("reason", ""))

        if decision == "replace" and candidates:
            alt_idx = result.get("fileIndex")
            if alt_idx and 1 <= alt_idx <= len(candidates):
                alt_fi = candidates[alt_idx - 1]
                log.info(
                    f"  2차 교체 [{item_idx}]: {low_match['file_name']} → "
                    f"{alt_fi['file_name']} (점수: {low_match['score']} → {new_score})"
                )
                # all_matches에서 해당 항목 교체
                for m in all_matches:
                    if m["item_index"] == item_idx:
                        m["file_id"] = alt_fi["file_id"]
                        m["file_name"] = alt_fi["file_name"]
                        m["score"] = new_score
                        m["reason"] = f"[2차 교체] {new_reason}"
                        if on_matches:
                            on_matches([m])
                        break
                continue

        if decision == "none":
            log.info(f"  2차 제거 [{item_idx}]: {low_match['file_name']} → 매칭 없음")
            for m in all_matches:
                if m["item_index"] == item_idx:
                    m["file_id"] = None
                    m["file_name"] = None
                    m["score"] = 0
                    m["reason"] = f"[2차 제거] {new_reason}"
                    if on_matches:
                        on_matches([m])
                    break
            continue

        # keep: 점수 재조정
        if new_score != low_match.get("score"):
            log.debug(f"  2차 유지 [{item_idx}]: 점수 {low_match['score']} → {new_score}")
            for m in all_matches:
                if m["item_index"] == item_idx:
                    m["score"] = new_score
                    m["reason"] = f"[2차 확인] {new_reason}"
                    if on_matches:
                        on_matches([m])
                    break

    return all_matches


def _call_openai_json(
    prompt: str, client: OpenAI, log: logging.Logger = None
) -> dict | list | None:
    """OpenAI API 호출 (JSON 응답)."""
    if not log:
        log = logging.getLogger("fillcontent")

    try:
        log.debug(f"  OpenAI API 호출: 모델={OPENAI_MODEL}")
        response = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            response_format={"type": "json_object"},
        )
        text = response.choices[0].message.content
        usage = response.usage
        if usage:
            log.debug(
                f"  토큰 사용: prompt={usage.prompt_tokens}, "
                f"completion={usage.completion_tokens}, "
                f"total={usage.total_tokens}"
            )
        return json.loads(text) if text else None
    except Exception as e:
        log.error(f"  OpenAI API 오류: {e}")
        return None


def _build_item_list(items: list[str]) -> str:
    """항목 리스트를 번호 매긴 텍스트로 변환."""
    if len(items) <= 60:
        return "\n".join(
            f"{i + 1}. {(item or '(빈 항목)')[:100]}"
            for i, item in enumerate(items)
        )

    front = "\n".join(
        f"{i + 1}. {(item or '')[:100]}"
        for i, item in enumerate(items[:50])
    )
    back = "\n".join(
        f"{len(items) - 10 + i + 1}. {(item or '')[:100]}"
        for i, item in enumerate(items[-10:])
    )
    return f"{front}\n... (중간 {len(items) - 60}개 생략) ...\n{back}"
